import { randomUUID } from 'node:crypto';
import type { FileRecord } from '../records';
import type { FileStore, ProcessingLedger } from '../store';

const T0 = '2026-01-01T00:00:00.000Z';
const T1 = '2026-01-01T00:00:10.000Z';

export function newRecord(overrides: Partial<FileRecord> = {}): FileRecord {
  const id = randomUUID();
  const userId = overrides.userId ?? 'alice';
  return {
    id, userId, fileName: 'a.bin', contentType: 'application/octet-stream', size: 100, status: 'uploading',
    partSize: 5 * 1024 * 1024, partCount: 1, s3Key: `uploads/${userId}/${id}/a.bin`, s3UploadId: 'u-1',
    createdAt: T0, updatedAt: T0, expiresAt: 1_900_000_000, ...overrides,
  };
}

/**
 * Behavioural contract for FileStore and ProcessingLedger. Runs against the in-memory
 * twin in unit tests and against real DynamoDB (LocalStack) in integration tests.
 */
export function fileStoreContract(name: string, make: () => Promise<{ store: FileStore; ledger: ProcessingLedger }> | { store: FileStore; ledger: ProcessingLedger }) {
  describe(`FileStore contract: ${name}`, () => {
    it('creates, reads and lists newest-first per user', async () => {
      const { store } = await make();
      const user = `u${randomUUID().slice(0, 8)}`;
      const older = newRecord({ userId: user, createdAt: '2026-01-01T00:00:00.000Z' });
      const newer = newRecord({ userId: user, createdAt: '2026-01-02T00:00:00.000Z' });
      const other = newRecord({ userId: 'someone-else' });
      await store.create(older);
      await store.create(newer);
      await store.create(other);
      expect(await store.get(older.id)).toMatchObject({ id: older.id, userId: user });
      expect((await store.listByUser(user)).map((r) => r.id)).toEqual([newer.id, older.id]);
      expect(await store.get('missing')).toBeUndefined();
    });

    it('refuses to overwrite an existing record', async () => {
      const { store } = await make();
      const r = newRecord();
      await store.create(r);
      await expect(store.create(r)).rejects.toThrow();
    });

    it('walks the happy path uploading -> uploaded -> processing -> ready', async () => {
      const { store } = await make();
      const r = newRecord();
      await store.create(r);
      const up = await store.markUploaded(r.id, { etag: '"abc-1"', versionId: 'v1', at: T1 });
      expect(up).toMatchObject({ status: 'uploaded', etag: '"abc-1"', versionId: 'v1', uploadedAt: T1 });
      expect(up?.expiresAt).toBeUndefined();
      expect(await store.markProcessing(r.id, T1)).toBe(true);
      expect(await store.markReady(r.id, { sha256: 'ff', size: 100 }, T1)).toBe(true);
      expect(await store.get(r.id)).toMatchObject({ status: 'ready', result: { sha256: 'ff', size: 100 }, processedAt: T1 });
    });

    it('lets the worker win the race: markUploaded after processing keeps status but records metadata', async () => {
      const { store } = await make();
      const r = newRecord();
      await store.create(r);
      expect(await store.markProcessing(r.id, T1)).toBe(true);
      const after = await store.markUploaded(r.id, { etag: '"e"', versionId: 'v9', at: T1 });
      expect(after).toMatchObject({ status: 'processing', etag: '"e"', versionId: 'v9' });
    });

    it('never moves backwards or out of terminal states', async () => {
      const { store } = await make();
      const r = newRecord();
      await store.create(r);
      await store.markProcessing(r.id, T1);
      await store.markReady(r.id, { sha256: 'a', size: 1 }, T1);
      expect(await store.markProcessing(r.id, T1)).toBe(false);
      expect(await store.markFailed(r.id, 'late failure', T1)).toBe(false);
      expect(await store.markAborted(r.id, T1)).toBe(false);
      expect((await store.get(r.id))?.status).toBe('ready');
    });

    it('records failures, and allows a retry back to processing', async () => {
      const { store } = await make();
      const r = newRecord();
      await store.create(r);
      expect(await store.markFailed(r.id, 'boom', T1)).toBe(true);
      expect(await store.get(r.id)).toMatchObject({ status: 'failed', error: 'boom' });
      expect(await store.markProcessing(r.id, T1)).toBe(true);
      const again = await store.get(r.id);
      expect(again?.status).toBe('processing');
      expect(again?.error).toBeUndefined();
    });

    it('aborts only while uploading, and aborted files do not accept uploads', async () => {
      const { store } = await make();
      const r = newRecord();
      await store.create(r);
      expect(await store.markAborted(r.id, T1)).toBe(true);
      expect(await store.markAborted(r.id, T1)).toBe(false);
      expect(await store.markUploaded(r.id, { at: T1 })).toBeUndefined();
      expect(await store.markProcessing(r.id, T1)).toBe(false);
      expect((await store.get(r.id))?.status).toBe('aborted');
    });

    it('does not resurrect unknown files', async () => {
      const { store } = await make();
      expect(await store.markProcessing('nope', T1)).toBe(false);
      expect(await store.markReady('nope', { sha256: 'a', size: 1 }, T1)).toBe(false);
      expect(await store.markUploaded('nope', { at: T1 })).toBeUndefined();
    });
  });

  describe(`ProcessingLedger contract: ${name}`, () => {
    const lease = 60_000;
    const t = (ms: number) => new Date(Date.UTC(2026, 0, 1) + ms);

    it('grants the lease once; a concurrent duplicate is told to come back later', async () => {
      const { ledger } = await make();
      const key = `k-${randomUUID()}#v1`;
      expect(await ledger.begin(key, t(0), lease)).toEqual({ outcome: 'acquired', attempts: 1 });
      expect(await ledger.begin(key, t(1000), lease)).toEqual({ outcome: 'in-progress' });
    });

    it('skips work that already completed', async () => {
      const { ledger } = await make();
      const key = `k-${randomUUID()}#v1`;
      await ledger.begin(key, t(0), lease);
      await ledger.complete(key, t(5));
      expect(await ledger.begin(key, t(10_000_000), lease)).toEqual({ outcome: 'completed' });
    });

    it('lets a retry take over after a failure', async () => {
      const { ledger } = await make();
      const key = `k-${randomUUID()}#v1`;
      await ledger.begin(key, t(0), lease);
      await ledger.fail(key, 'boom', t(5));
      expect(await ledger.begin(key, t(10), lease)).toEqual({ outcome: 'acquired', attempts: 2 });
    });

    it('lets a retry take over after a crashed worker\'s lease expires', async () => {
      const { ledger } = await make();
      const key = `k-${randomUUID()}#v1`;
      await ledger.begin(key, t(0), lease);
      expect(await ledger.begin(key, t(lease - 1), lease)).toEqual({ outcome: 'in-progress' });
      expect(await ledger.begin(key, t(lease + 1), lease)).toEqual({ outcome: 'acquired', attempts: 2 });
    });

    it('keeps different object versions independent', async () => {
      const { ledger } = await make();
      const base = `k-${randomUUID()}`;
      await ledger.begin(`${base}#v1`, t(0), lease);
      await ledger.complete(`${base}#v1`, t(1));
      expect(await ledger.begin(`${base}#v2`, t(2), lease)).toMatchObject({ outcome: 'acquired' });
    });

    it('grants the lease to exactly one of many racing deliveries', async () => {
      const { ledger } = await make();
      const key = `k-${randomUUID()}#v1`;
      const results = await Promise.all(Array.from({ length: 10 }, () => ledger.begin(key, t(0), lease)));
      expect(results.filter((r) => r.outcome === 'acquired')).toHaveLength(1);
    });
  });
}
