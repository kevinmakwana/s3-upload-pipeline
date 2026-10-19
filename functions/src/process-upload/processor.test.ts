import { createHash, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { Jimp } from 'jimp';
import { MemoryFileStore, MemoryLedger, type FileRecord } from '@s3up/data';
import { newRecord } from '../../../packages/data/src/testing/contract';
import { ProcessingInProgressError, idempotencyKey, processObject, type ObjectStorage, type ProcessorDeps } from './processor';
import { handleBatch } from './handler';
import type { SQSEvent } from 'aws-lambda';

class FakeStorage implements ObjectStorage {
  objects = new Map<string, Buffer>();
  thumbnails = new Map<string, Buffer>();
  streamCalls = 0;
  failStream = 0;
  async head(key: string) {
    const o = this.objects.get(key);
    if (!o) throw new Error('NoSuchKey');
    return { size: o.length };
  }
  async readHead(key: string, _v: string | undefined, length: number) {
    return this.objects.get(key)!.subarray(0, length);
  }
  async stream(key: string) {
    this.streamCalls++;
    if (this.failStream > 0) {
      this.failStream--;
      throw new Error('connection reset');
    }
    return Readable.from([this.objects.get(key)!]);
  }
  async readAll(key: string) {
    return this.objects.get(key)!;
  }
  async putThumbnail(key: string, body: Buffer) {
    this.thumbnails.set(key, body);
  }
}

function setup() {
  const files = new MemoryFileStore();
  const ledger = new MemoryLedger();
  const storage = new FakeStorage();
  const deps: ProcessorDeps = {
    files, ledger, storage,
    config: { thumbnailMaxBytes: 1024 * 1024, leaseMs: 60_000, maxReceiveCount: 3 },
    log: () => undefined,
  };
  async function addFile(content: Buffer, overrides: Partial<FileRecord> = {}) {
    const id = randomUUID();
    const userId = overrides.userId ?? 'alice';
    const record = newRecord({ id, userId, size: content.length, s3Key: `uploads/${userId}/${id}/f.bin`, status: 'uploaded', ...overrides });
    await files.create(record);
    storage.objects.set(record.s3Key, content);
    return record;
  }
  return { deps, files, ledger, storage, addFile };
}

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

async function pngBuffer(w: number, h: number) {
  return Buffer.from(await new Jimp({ width: w, height: h, color: 0xff0000ff }).getBuffer('image/png'));
}

describe('processObject', () => {
  it('computes the checksum and marks the file ready', async () => {
    const { deps, files, addFile } = setup();
    const content = Buffer.from('hello world'.repeat(1000));
    const rec = await addFile(content);
    const out = await processObject(deps, { key: rec.s3Key, versionId: 'v1' });
    expect(out).toMatchObject({ type: 'processed', result: { sha256: sha(content), size: content.length, thumbnailSkipped: 'not an image' } });
    expect(await files.get(rec.id)).toMatchObject({ status: 'ready', result: { sha256: sha(content) } });
  });

  it('extracts dimensions and writes a thumbnail for images', async () => {
    const { deps, files, storage, addFile } = setup();
    const png = await pngBuffer(640, 480);
    const rec = await addFile(png, { contentType: 'image/png' });
    const out = await processObject(deps, { key: rec.s3Key, versionId: 'v1' });
    expect(out.type).toBe('processed');
    const result = (await files.get(rec.id))!.result!;
    expect(result).toMatchObject({ width: 640, height: 480, detectedType: 'image/png', thumbnailKey: `thumbnails/alice/${rec.id}.jpg` });
    const thumb = await Jimp.read(storage.thumbnails.get(result.thumbnailKey!)!);
    expect(Math.max(thumb.width, thumb.height)).toBe(256);
  });

  it('skips thumbnails for oversized images but still checksums them', async () => {
    const { deps, files, addFile } = setup();
    deps.config.thumbnailMaxBytes = 10;
    const rec = await addFile(await pngBuffer(8, 8), { contentType: 'image/png' });
    await processObject(deps, { key: rec.s3Key, versionId: 'v1' });
    expect((await files.get(rec.id))!.result).toMatchObject({ thumbnailSkipped: expect.stringContaining('larger than') });
  });

  it('does not fail the upload when an image cannot be decoded', async () => {
    const { deps, files, addFile } = setup();
    const broken = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('not really a png')]);
    const rec = await addFile(broken, { contentType: 'image/png' });
    await processObject(deps, { key: rec.s3Key, versionId: 'v1' });
    const got = (await files.get(rec.id))!;
    expect(got.status).toBe('ready');
    expect(got.result?.thumbnailSkipped).toMatch(/could not decode/);
  });

  describe('idempotency', () => {
    it('a duplicate delivery of the same key+version does no work', async () => {
      const { deps, storage, addFile } = setup();
      const rec = await addFile(Buffer.from('abc'));
      const ref = { key: rec.s3Key, versionId: 'v1' };
      expect((await processObject(deps, ref)).type).toBe('processed');
      expect((await processObject(deps, ref)).type).toBe('duplicate');
      expect((await processObject(deps, ref)).type).toBe('duplicate');
      expect(storage.streamCalls).toBe(1);
    });

    it('a new version of the same key is processed again', async () => {
      const { deps, storage, addFile } = setup();
      const rec = await addFile(Buffer.from('abc'));
      await processObject(deps, { key: rec.s3Key, versionId: 'v1' });
      expect((await processObject(deps, { key: rec.s3Key, versionId: 'v2' })).type).toBe('processed');
      expect(storage.streamCalls).toBe(2);
    });

    it('falls back to the ETag when the bucket is unversioned', () => {
      expect(idempotencyKey({ key: 'k', etag: 'e1' })).toBe('k#e1');
      expect(idempotencyKey({ key: 'k', versionId: 'v', etag: 'e1' })).toBe('k#v');
    });

    it('concurrent duplicate deliveries do the work once', async () => {
      const { deps, storage, addFile } = setup();
      const rec = await addFile(Buffer.from('abc'));
      const ref = { key: rec.s3Key, versionId: 'v1' };
      const results = await Promise.allSettled([processObject(deps, ref), processObject(deps, ref), processObject(deps, ref)]);
      expect(results.filter((r) => r.status === 'fulfilled' && r.value.type === 'processed')).toHaveLength(1);
      expect(storage.streamCalls).toBe(1);
      for (const r of results) if (r.status === 'rejected') expect(r.reason).toBeInstanceOf(ProcessingInProgressError);
    });

    it('asks SQS to retry while another worker holds the lease', async () => {
      const { deps, ledger, addFile } = setup();
      const rec = await addFile(Buffer.from('abc'));
      await ledger.begin(idempotencyKey({ key: rec.s3Key, versionId: 'v1' }), new Date(), 60_000);
      await expect(processObject(deps, { key: rec.s3Key, versionId: 'v1' })).rejects.toBeInstanceOf(ProcessingInProgressError);
    });
  });

  describe('failures', () => {
    it('keeps the file processing and rethrows on a transient failure, then succeeds on retry', async () => {
      const { deps, files, storage, addFile } = setup();
      const rec = await addFile(Buffer.from('abc'));
      const ref = { key: rec.s3Key, versionId: 'v1' };
      storage.failStream = 1;
      await expect(processObject(deps, ref, 1)).rejects.toThrow('connection reset');
      expect((await files.get(rec.id))!.status).toBe('processing');
      expect((await processObject(deps, ref, 2)).type).toBe('processed');
      expect((await files.get(rec.id))!.status).toBe('ready');
    });

    it('marks the file failed on the final delivery attempt, while still rethrowing for the DLQ', async () => {
      const { deps, files, storage, addFile } = setup();
      const rec = await addFile(Buffer.from('abc'));
      storage.failStream = 5;
      await expect(processObject(deps, { key: rec.s3Key, versionId: 'v1' }, 3)).rejects.toThrow();
      expect(await files.get(rec.id)).toMatchObject({ status: 'failed', error: expect.stringContaining('after 3 attempts') });
    });

    it('rejects content that does not match the declared type, without retrying', async () => {
      const { deps, files, storage, addFile } = setup();
      const zip = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(64)]);
      const rec = await addFile(zip, { contentType: 'image/png' });
      const out = await processObject(deps, { key: rec.s3Key, versionId: 'v1' });
      expect(out).toMatchObject({ type: 'rejected', reason: expect.stringContaining('application/zip') });
      expect(await files.get(rec.id)).toMatchObject({ status: 'failed' });
      expect(storage.streamCalls).toBe(0);
      // A duplicate delivery doesn't redo the verdict.
      expect((await processObject(deps, { key: rec.s3Key, versionId: 'v1' })).type).toBe('duplicate');
    });

    it('rejects an object whose size differs from what was declared', async () => {
      const { deps, files, addFile } = setup();
      const rec = await addFile(Buffer.from('abc'), { size: 999 });
      const out = await processObject(deps, { key: rec.s3Key, versionId: 'v1' });
      expect(out.type).toBe('rejected');
      expect((await files.get(rec.id))!.status).toBe('failed');
    });
  });

  describe('ignored events', () => {
    it('ignores keys outside the uploads layout and thumbnails (no event loops)', async () => {
      const { deps } = setup();
      expect((await processObject(deps, { key: 'thumbnails/alice/x.jpg' })).type).toBe('ignored');
      expect((await processObject(deps, { key: 'random/file' })).type).toBe('ignored');
    });
    it('ignores objects with no matching record, a different owner, or an aborted upload', async () => {
      const { deps, files, addFile } = setup();
      const id = randomUUID();
      expect((await processObject(deps, { key: `uploads/alice/${id}/x.bin` })).type).toBe('ignored');
      const rec = await addFile(Buffer.from('abc'));
      const spoofed = rec.s3Key.replace('uploads/alice/', 'uploads/mallory/');
      expect((await processObject(deps, { key: spoofed })).type).toBe('ignored');
      await files.markAborted(rec.id, 't');
      const rec2 = await addFile(Buffer.from('abc'), { status: 'aborted' });
      expect((await processObject(deps, { key: rec2.s3Key })).type).toBe('ignored');
    });
    it('never brings a quarantined file back into service, even if its event arrives after the scan', async () => {
      const { deps, files, addFile } = setup();
      const rec = await addFile(Buffer.from('abc'));
      await files.markQuarantined(rec.id, 'Malware found', 't');
      expect(await processObject(deps, { key: rec.s3Key })).toEqual({ type: 'ignored', reason: 'file was quarantined' });
      expect((await files.get(rec.id))?.status).toBe('quarantined');
    });
  });
});

describe('handleBatch (SQS partial batch response)', () => {
  const s3Body = (key: string, versionId = 'v1', eventName = 'ObjectCreated:CompleteMultipartUpload') =>
    JSON.stringify({ Records: [{ eventName, s3: { object: { key: encodeURIComponent(key).replace(/%20/g, '+'), versionId, eTag: 'e' } } }] });
  const message = (messageId: string, body: string, receiveCount = '1') =>
    ({ messageId, body, attributes: { ApproximateReceiveCount: receiveCount } }) as unknown as SQSEvent['Records'][number];

  it('reports only the failed messages', async () => {
    const { deps, storage, addFile } = setup();
    const good = await addFile(Buffer.from('good'));
    const bad = await addFile(Buffer.from('bad'));
    storage.objects.delete(bad.s3Key); // head() fails -> transient error
    const res = await handleBatch(
      { Records: [message('m1', s3Body(good.s3Key)), message('m2', s3Body(bad.s3Key)), message('m3', 'not json')] },
      deps,
    );
    expect(res.batchItemFailures.map((f) => f.itemIdentifier).sort()).toEqual(['m2', 'm3']);
  });

  it('ignores S3 test events and non-create events', async () => {
    const { deps } = setup();
    const res = await handleBatch(
      { Records: [message('t', JSON.stringify({ Event: 's3:TestEvent' })), message('r', s3Body('uploads/a/b/c', 'v', 'ObjectRemoved:Delete'))] },
      deps,
    );
    expect(res.batchItemFailures).toEqual([]);
  });

  it('decodes URL-encoded keys (spaces arrive as "+")', async () => {
    const { deps, files } = setup();
    const id = randomUUID();
    const key = `uploads/alice/${id}/my file.bin`;
    const rec = newRecord({ id, size: 3, s3Key: key, status: 'uploaded' });
    await files.create(rec);
    const content = Buffer.from('abc');
    (deps.storage as FakeStorage).objects.set(key, content);
    const res = await handleBatch({ Records: [message('m', s3Body(key))] }, deps);
    expect(res.batchItemFailures).toEqual([]);
    expect((await files.get(id))!.status).toBe('ready');
  });
});
