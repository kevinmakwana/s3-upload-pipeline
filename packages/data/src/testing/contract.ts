import { randomUUID } from 'node:crypto';
import { InvalidCursorError } from '../cursor';
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
      expect((await store.listByUser(user)).items.map((r) => r.id)).toEqual([newer.id, older.id]);
      expect((await store.listByUser(user)).nextCursor).toBeUndefined();
      expect(await store.get('missing')).toBeUndefined();
    });

    describe('listByUser pagination', () => {
      const at = (n: number) => `2026-02-01T00:00:${String(n).padStart(2, '0')}.000Z`;
      async function seed(store: FileStore, count: number, stamp = at) {
        const user = `u${randomUUID().slice(0, 8)}`;
        const records: FileRecord[] = [];
        for (let i = 1; i <= count; i++) {
          const r = newRecord({ userId: user, createdAt: stamp(i) });
          await store.create(r);
          records.push(r);
        }
        return { user, newestFirst: [...records].reverse().map((r) => r.id), records };
      }
      async function walk(store: FileStore, user: string, limit: number, excludeAborted = false) {
        const pages: string[][] = [];
        let cursor: string | undefined;
        do {
          const page = await store.listByUser(user, { limit, cursor, excludeAborted });
          pages.push(page.items.map((r) => r.id));
          cursor = page.nextCursor;
        } while (cursor && pages.length < 50);
        return pages;
      }

      it('walks the list newest-first in pages, with no gaps or repeats', async () => {
        const { store } = await make();
        const { user, newestFirst } = await seed(store, 7);
        const pages = await walk(store, user, 3);
        expect(pages.map((p) => p.length)).toEqual([3, 3, 1]);
        expect(pages.flat()).toEqual(newestFirst);
      });

      it('gives no cursor (and no empty trailing page) when the last page is exactly full', async () => {
        const { store } = await make();
        const { user, newestFirst } = await seed(store, 6);
        const first = await store.listByUser(user, { limit: 3 });
        expect(first.nextCursor).toEqual(expect.any(String));
        const second = await store.listByUser(user, { limit: 3, cursor: first.nextCursor });
        expect(second.items.map((r) => r.id)).toEqual(newestFirst.slice(3));
        expect(second.nextCursor).toBeUndefined();
      });

      it('keeps records with an identical createdAt in a stable order, each exactly once', async () => {
        const { store } = await make();
        const { user, records } = await seed(store, 5, () => at(1));
        const pages = await walk(store, user, 2);
        expect(pages.flat().sort()).toEqual(records.map((r) => r.id).sort());
      });

      it('fills every page when aborted records are excluded', async () => {
        const { store } = await make();
        const { user, newestFirst } = await seed(store, 7);
        for (const id of [newestFirst[0]!, newestFirst[2]!, newestFirst[3]!, newestFirst[4]!]) await store.markAborted(id, T1);
        const expected = [newestFirst[1]!, newestFirst[5]!, newestFirst[6]!];
        const pages = await walk(store, user, 2, true);
        expect(pages).toEqual([expected.slice(0, 2), expected.slice(2)]);
        expect((await walk(store, user, 10, false))[0]).toHaveLength(7); // included unless asked
      });

      it('never returns another user\'s records, even with a cursor taken from someone else', async () => {
        const { store } = await make();
        const a = await seed(store, 3);
        const b = await seed(store, 3);
        const cursor = (await store.listByUser(a.user, { limit: 1 })).nextCursor;
        const page = await store.listByUser(b.user, { limit: 10, cursor });
        expect(page.items.every((r) => r.userId === b.user)).toBe(true);
      });

      it.each(['not-a-cursor', 'e30', Buffer.from('{"i":1,"c":2}').toString('base64url'), 'x'.repeat(5000)])(
        'rejects a malformed cursor (%#)',
        async (cursor) => {
          const { store } = await make();
          await expect(store.listByUser('alice', { cursor, limit: 5 })).rejects.toBeInstanceOf(InvalidCursorError);
        },
      );

      it('clamps the limit to at least one record', async () => {
        const { store } = await make();
        const { user } = await seed(store, 2);
        expect((await store.listByUser(user, { limit: 0 })).items).toHaveLength(1);
      });
    });

    describe('remove', () => {
      it.each([['ready'], ['failed']] as const)('deletes a %s record, and it disappears from get and list', async (finalStatus) => {
        const { store } = await make();
        const r = newRecord();
        await store.create(r);
        await store.markProcessing(r.id, T1);
        if (finalStatus === 'ready') await store.markReady(r.id, { sha256: 'a', size: 1 }, T1);
        else await store.markFailed(r.id, 'bad', T1);
        expect(await store.remove(r.id)).toBe(true);
        expect(await store.get(r.id)).toBeUndefined();
        expect((await store.listByUser(r.userId)).items.map((x) => x.id)).not.toContain(r.id);
        expect(await store.remove(r.id)).toBe(false); // already gone
      });

      it.each([['uploading'], ['uploaded'], ['processing'], ['aborted']] as const)('refuses to delete a record that is %s', async (status) => {
        const { store } = await make();
        const r = newRecord();
        await store.create(r);
        if (status === 'uploaded') await store.markUploaded(r.id, { at: T1 });
        if (status === 'processing') await store.markProcessing(r.id, T1);
        if (status === 'aborted') await store.markAborted(r.id, T1);
        expect(await store.remove(r.id)).toBe(false);
        expect((await store.get(r.id))?.status).toBe(status);
      });

      it('returns false for a record that never existed', async () => {
        const { store } = await make();
        expect(await store.remove('missing')).toBe(false);
      });
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
