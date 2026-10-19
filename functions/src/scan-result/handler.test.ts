import { randomUUID } from 'node:crypto';
import { buildObjectKey, buildThumbnailKey } from '@s3up/core';
import { MemoryFileStore } from '@s3up/data';
import { newRecord } from '../../../packages/data/src/testing/contract';
import { handleScanResult, type ScanResultDeps, type ScanResultEvent } from './handler';

const BUCKET = 'uploads-bucket';

function setup() {
  const files = new MemoryFileStore();
  const deleted: string[] = [];
  const logs: { message: string; fields?: Record<string, unknown> }[] = [];
  const deps: ScanResultDeps = {
    files,
    bucket: BUCKET,
    deleteAllVersions: async (key) => void deleted.push(key),
    now: () => new Date('2026-02-01T00:00:00.000Z'),
    log: (message, fields) => void logs.push({ message, fields }),
  };
  return { files, deps, deleted, logs };
}

async function addFile(files: MemoryFileStore, overrides: Parameters<typeof newRecord>[0] = {}) {
  const id = randomUUID();
  const record = newRecord({ id, s3Key: buildObjectKey('alice', id, 'report.pdf'), ...overrides });
  await files.create(record);
  return record;
}

const event = (objectKey: string, status: string, extra: Partial<ScanResultEvent['detail']> = {}, bucketName = BUCKET): ScanResultEvent => ({
  'detail-type': 'GuardDuty Malware Protection Object Scan Result',
  source: 'aws.guardduty',
  detail: {
    scanStatus: status === 'THREATS_FOUND' || status === 'NO_THREATS_FOUND' ? 'COMPLETED' : 'SKIPPED',
    s3ObjectDetails: { bucketName, objectKey, versionId: 'v1' },
    scanResultDetails: { scanResultStatus: status, threats: status === 'THREATS_FOUND' ? [{ name: 'Eicar-Test-Signature' }] : null },
    ...extra,
  },
});

describe('handleScanResult', () => {
  it('quarantines an infected file, says why, and deletes the object and its thumbnail', async () => {
    const { files, deps, deleted } = setup();
    const rec = await addFile(files);
    await files.markProcessing(rec.id, 't');
    await files.markReady(rec.id, { sha256: 'a', size: 1, thumbnailKey: buildThumbnailKey('alice', rec.id) }, 't');

    const outcome = await handleScanResult(event(rec.s3Key, 'THREATS_FOUND'), deps);

    expect(outcome).toEqual({ type: 'quarantined', fileId: rec.id });
    expect(await files.get(rec.id)).toMatchObject({ status: 'quarantined', error: 'Malware found: Eicar-Test-Signature', updatedAt: '2026-02-01T00:00:00.000Z' });
    expect((await files.get(rec.id))?.result).toBeUndefined();
    expect(deleted.sort()).toEqual([rec.s3Key, buildThumbnailKey('alice', rec.id)].sort());
  });

  it('marks the file before touching storage, so a failed delete still leaves it out of service and can be retried', async () => {
    const { files, deps } = setup();
    const rec = await addFile(files);
    deps.deleteAllVersions = async () => {
      throw new Error('S3 is down');
    };
    await expect(handleScanResult(event(rec.s3Key, 'THREATS_FOUND'), deps)).rejects.toThrow('S3 is down');
    expect((await files.get(rec.id))?.status).toBe('quarantined');

    const retry = setup();
    retry.files.records.set(rec.id, (await files.get(rec.id))!);
    expect(await handleScanResult(event(rec.s3Key, 'THREATS_FOUND'), retry.deps)).toEqual({ type: 'quarantined', fileId: rec.id });
    expect(retry.deleted).toContain(rec.s3Key);
  });

  it('handles a file that is still uploading or processing, and one the worker has not seen yet', async () => {
    const { files, deps } = setup();
    for (const move of [async () => undefined, async (id: string) => void (await files.markProcessing(id, 't'))]) {
      const rec = await addFile(files);
      await move(rec.id);
      expect((await handleScanResult(event(rec.s3Key, 'THREATS_FOUND'), deps)).type).toBe('quarantined');
      expect((await files.get(rec.id))?.status).toBe('quarantined');
    }
  });

  it('is safe to deliver twice', async () => {
    const { files, deps, deleted } = setup();
    const rec = await addFile(files);
    await handleScanResult(event(rec.s3Key, 'THREATS_FOUND'), deps);
    expect((await handleScanResult(event(rec.s3Key, 'THREATS_FOUND'), deps)).type).toBe('quarantined');
    expect((await files.get(rec.id))?.status).toBe('quarantined');
    expect(deleted.length).toBeGreaterThanOrEqual(2);
  });

  it('does nothing for a clean result', async () => {
    const { files, deps, deleted, logs } = setup();
    const rec = await addFile(files);
    expect(await handleScanResult(event(rec.s3Key, 'NO_THREATS_FOUND'), deps)).toEqual({ type: 'recorded', status: 'NO_THREATS_FOUND' });
    expect((await files.get(rec.id))?.status).toBe('uploading');
    expect(deleted).toEqual([]);
    expect(logs.map((l) => l.message)).toContain('scan result');
  });

  it.each(['UNSUPPORTED', 'ACCESS_DENIED', 'FAILED'])('records a %s result without deleting anything (the API will not serve the file)', async (status) => {
    const { files, deps, deleted, logs } = setup();
    const rec = await addFile(files);
    expect(await handleScanResult(event(rec.s3Key, status), deps)).toEqual({ type: 'recorded', status });
    expect(deleted).toEqual([]);
    expect(logs.find((l) => l.message === 'file could not be scanned')?.fields).toMatchObject({ key: rec.s3Key, status });
  });

  it('ignores another bucket, a key outside the uploads layout, and a file that does not match', async () => {
    const { files, deps, deleted } = setup();
    const rec = await addFile(files);
    expect((await handleScanResult(event(rec.s3Key, 'THREATS_FOUND', {}, 'some-other-bucket'), deps)).type).toBe('ignored');
    expect((await handleScanResult(event('thumbnails/alice/x.jpg', 'THREATS_FOUND'), deps)).type).toBe('ignored');
    expect((await handleScanResult(event(`uploads/alice/${randomUUID()}/x.bin`, 'THREATS_FOUND'), deps)).type).toBe('ignored');
    // The same id under another user's prefix is not this user's file.
    expect((await handleScanResult(event(rec.s3Key.replace('uploads/alice/', 'uploads/mallory/'), 'THREATS_FOUND'), deps)).type).toBe('ignored');
    expect((await files.get(rec.id))?.status).toBe('uploading');
    expect(deleted).toEqual([]);
  });

  it('leaves an aborted upload alone', async () => {
    const { files, deps, deleted } = setup();
    const rec = await addFile(files);
    await files.markAborted(rec.id, 't');
    expect((await handleScanResult(event(rec.s3Key, 'THREATS_FOUND'), deps)).type).toBe('ignored');
    expect(deleted).toEqual([]);
  });

  it('copes with several or missing threat names, and keeps the reason short', async () => {
    const { files, deps } = setup();
    const a = await addFile(files);
    await handleScanResult(event(a.s3Key, 'THREATS_FOUND', { scanResultDetails: { scanResultStatus: 'THREATS_FOUND', threats: [{ name: 'A' }, { name: 'B' }] } }), deps);
    expect((await files.get(a.id))?.error).toBe('Malware found: A, B');
    const b = await addFile(files);
    await handleScanResult(event(b.s3Key, 'THREATS_FOUND', { scanResultDetails: { scanResultStatus: 'THREATS_FOUND', threats: null } }), deps);
    expect((await files.get(b.id))?.error).toBe('Malware found');
    const c = await addFile(files);
    const many = Array.from({ length: 50 }, (_, i) => ({ name: `Threat-${i}-with-a-long-name` }));
    await handleScanResult(event(c.s3Key, 'THREATS_FOUND', { scanResultDetails: { scanResultStatus: 'THREATS_FOUND', threats: many } }), deps);
    expect((await files.get(c.id))!.error!.length).toBeLessThanOrEqual(300);
  });

  it('rejects an event that is not a scan result', async () => {
    const { deps } = setup();
    await expect(handleScanResult({ detail: {} } as unknown as ScanResultEvent, deps)).rejects.toThrow(/scan result/i);
  });
});
