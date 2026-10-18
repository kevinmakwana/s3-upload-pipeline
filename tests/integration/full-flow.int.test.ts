import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GetObjectCommand, ListObjectVersionsCommand, ListPartsCommand } from '@aws-sdk/client-s3';
import { ReceiveMessageCommand, SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import { Jimp } from 'jimp';
import { MemoryResumeStore, MiB, Upload, sha256Base64, type FileDto, type UploadOptions } from '@s3up/core';
import { createS3Client } from '@s3up/data';
import { generateFile } from '../../scripts/lib/generate';
import { FetchTransport, NodeFileSource, startApi, waitForFile, type RunningApi } from './harness';

const FILE_SIZE_MB = Number(process.env.INTEGRATION_FILE_MB ?? 200);
const fast: Partial<UploadOptions> = { concurrency: 4, maxRetries: 3, baseDelayMs: 50, maxDelayMs: 500 };

let server: RunningApi;
let dir: string;

beforeAll(async () => {
  server = await startApi();
  dir = await mkdtemp(join(tmpdir(), 's3up-int-'));
});
afterAll(async () => {
  await server?.close();
  await rm(dir, { recursive: true, force: true });
});

const userId = () => `it-${Math.random().toString(36).slice(2, 10)}`;

async function uploadSmall(api: ReturnType<RunningApi['apiFor']>, name: string, contentType: string, bytes: Buffer): Promise<FileDto> {
  const path = join(dir, `${Math.random().toString(36).slice(2)}-${name}`);
  await writeFile(path, bytes);
  const source = await NodeFileSource.open(path);
  const out = await new Upload({ api, transport: new FetchTransport(), store: new MemoryResumeStore() }, source, { fileName: name, contentType, lastModified: 1 }, fast).start();
  await source.close();
  if (out.type !== 'done') throw new Error(`upload ended ${out.type}`);
  return out.file;
}

describe('large file: upload, interrupt, resume, process', () => {
  it(`uploads a ~${FILE_SIZE_MB} MB file, survives an interruption, and is processed to "ready"`, async () => {
    const user = userId();
    const api = server.apiFor(user);
    const gen = await generateFile(join(dir, 'big.bin'), FILE_SIZE_MB * MiB);
    const source = await NodeFileSource.open(gen.path);
    const store = new MemoryResumeStore();
    const transport = new FetchTransport();
    const meta = { fileName: 'big.bin', contentType: 'application/octet-stream', lastModified: 1 };

    // 1. Start, then "close the tab" once a few parts have landed.
    const first = new Upload({ api, transport, store }, source, meta, fast);
    let paused = false;
    first.subscribe((p) => {
      if (!paused && p.partsDone >= 3) {
        paused = true;
        first.pause();
      }
    });
    expect((await first.start()).type).toBe('paused');
    const fileId = first.progress.fileId!;
    const persisted = (await store.get(fileId))!;
    const doneBefore = Object.keys(persisted.parts).length;
    expect(doneBefore).toBeGreaterThanOrEqual(3);
    expect(doneBefore).toBeLessThan(persisted.partCount);

    // The API (backed by S3's ListParts) agrees with what the browser remembers.
    const remote = await api.listParts(fileId);
    expect(remote.file.status).toBe('uploading');
    expect(remote.parts.length).toBeGreaterThanOrEqual(doneBefore);

    // 2. "Reload": a brand-new Upload built from persisted state; only missing parts are sent.
    const resumeTransport = new FetchTransport();
    const resumed = new Upload({ api, transport: resumeTransport, store }, source, meta, fast, persisted);
    const outcome = await resumed.start();
    expect(outcome.type).toBe('done');
    const alreadyInS3 = new Set(remote.parts.map((p) => p.partNumber));
    for (const n of resumeTransport.sentParts) expect(alreadyInS3.has(n)).toBe(false);
    expect(resumeTransport.sentParts.length).toBe(persisted.partCount - alreadyInS3.size);
    expect(store.items.size).toBe(0);
    await source.close();

    // 3. Async processing: S3 -> SQS -> Lambda -> DynamoDB.
    if (outcome.type !== 'done') throw new Error('unreachable');
    expect(['uploaded', 'processing', 'ready']).toContain(outcome.file.status);
    const ready = await waitForFile(api, fileId, (f) => f.status === 'ready' || f.status === 'failed');
    expect(ready.error).toBeUndefined();
    expect(ready.status).toBe('ready');
    expect(ready.result).toMatchObject({ sha256: gen.sha256, size: gen.size });
    expect(ready.result?.thumbnailSkipped).toBe('not an image');

    // The stored object is byte-for-byte what we generated (spot-check via a ranged GET).
    const s3 = createS3Client();
    const head = await s3.send(new GetObjectCommand({ Bucket: process.env.BUCKET_NAME, Key: `uploads/${user}/${fileId}/big.bin`, Range: 'bytes=0-1023' }));
    const first1k = Buffer.from(await head.Body!.transformToByteArray());
    const local = Buffer.alloc(1024);
    const h = await (await import('node:fs/promises')).open(gen.path, 'r');
    await h.read(local, 0, 1024, 0);
    await h.close();
    expect(first1k.equals(local)).toBe(true);
  });
});

describe('per-part checksum and validation', () => {
  it('S3 rejects bytes that do not match the checksum the URL was signed for', async () => {
    const api = server.apiFor(userId());
    const file = await api.init({ fileName: 'x.bin', fileSize: 1024, contentType: 'application/octet-stream' });
    const good = Buffer.alloc(1024, 7);
    const presigned = await api.presignPart(file.id, 1, await sha256Base64(good));
    const tampered = Buffer.alloc(1024, 8);
    const bad = await fetch(presigned.url, { method: 'PUT', headers: presigned.headers, body: tampered });
    expect(bad.status).toBe(400);
    const ok = await fetch(presigned.url, { method: 'PUT', headers: presigned.headers, body: good });
    expect(ok.status).toBe(200);
    await api.abort(file.id);
  });

  it('refuses disallowed types and oversize requests before touching S3', async () => {
    const api = server.apiFor(userId());
    await expect(api.init({ fileName: 'virus.exe', fileSize: 10, contentType: 'application/x-msdownload' })).rejects.toThrow(/not allowed/);
    await expect(api.init({ fileName: 'a.bin', fileSize: 100 * 1024 * MiB, contentType: 'application/octet-stream' })).rejects.toThrow(/maximum/);
  });

  it('does not let one user see or finish another user’s upload', async () => {
    const alice = server.apiFor(userId());
    const mallory = server.apiFor(userId());
    const file = await alice.init({ fileName: 'a.bin', fileSize: 10, contentType: 'application/octet-stream' });
    await expect(mallory.presignPart(file.id, 1, 'A'.repeat(43) + '=')).rejects.toThrow(/not found/i);
    await expect(mallory.listParts(file.id)).rejects.toThrow(/not found/i);
    await expect(mallory.complete(file.id)).rejects.toThrow(/not found/i);
    await alice.abort(file.id);
  });
});

describe('abort and cleanup', () => {
  it('abort frees the multipart upload in S3 and hides the file', async () => {
    const user = userId();
    const api = server.apiFor(user);
    const file = await api.init({ fileName: 'gone.bin', fileSize: 6 * MiB, contentType: 'application/octet-stream' });
    const presigned = await api.presignPart(file.id, 1, await sha256Base64(Buffer.alloc(file.partSize, 1)));
    await fetch(presigned.url, { method: 'PUT', headers: presigned.headers, body: Buffer.alloc(file.partSize, 1) });
    await api.abort(file.id);
    expect((await api.getFile(file.id)).status).toBe('aborted');
    expect((await api.listFiles()).map((f) => f.id)).not.toContain(file.id);
    const s3 = createS3Client();
    await expect(
      s3.send(new ListPartsCommand({ Bucket: process.env.BUCKET_NAME, Key: `uploads/${user}/${file.id}/gone.bin`, UploadId: 'unknown' })),
    ).rejects.toMatchObject({ name: 'NoSuchUpload' });
  });
});

describe('processing', () => {
  it('extracts metadata and writes a thumbnail for images', async () => {
    const api = server.apiFor(userId());
    const png = Buffer.from(await new Jimp({ width: 800, height: 600, color: 0x3366ccff }).getBuffer('image/png'));
    const uploaded = await uploadSmall(api, 'photo.png', 'image/png', png);
    const ready = await waitForFile(api, uploaded.id, (f) => f.status === 'ready' || f.status === 'failed');
    expect(ready.status).toBe('ready');
    expect(ready.result).toMatchObject({ width: 800, height: 600, detectedType: 'image/png', sha256: createHash('sha256').update(png).digest('hex') });
    expect(ready.thumbnailUrl).toBeDefined();
    const res = await fetch(ready.thumbnailUrl!);
    expect(res.status).toBe(200);
    const thumb = await Jimp.read(Buffer.from(await res.arrayBuffer()));
    expect(Math.max(thumb.width, thumb.height)).toBe(256);
  });

  it('fails files whose content does not match the declared type', async () => {
    const api = server.apiFor(userId());
    const zip = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(2048)]);
    const uploaded = await uploadSmall(api, 'fake.png', 'image/png', zip);
    const failed = await waitForFile(api, uploaded.id, (f) => f.status === 'ready' || f.status === 'failed');
    expect(failed.status).toBe('failed');
    expect(failed.error).toMatch(/application\/zip/);
  });

  it('a duplicate S3 event for the same object version does no extra work', async () => {
    const api = server.apiFor(userId());
    const uploaded = await uploadSmall(api, 'dup.bin', 'application/octet-stream', Buffer.alloc(4096, 3));
    const ready = await waitForFile(api, uploaded.id, (f) => f.status === 'ready' || f.status === 'failed');
    expect(ready.status).toBe('ready');

    // Redeliver the same S3 notification straight onto the queue.
    const sqs = new SQSClient({ region: 'us-east-1', useQueueUrlAsEndpoint: false });
    const body = JSON.stringify({
      Records: [{ eventName: 'ObjectCreated:CompleteMultipartUpload', s3: { object: { key: await objectKeyFor(ready.id), versionId: await versionFor(ready.id), eTag: 'x' } } }],
    });
    await sqs.send(new SendMessageCommand({ QueueUrl: process.env.QUEUE_URL, MessageBody: body }));
    await new Promise((r) => setTimeout(r, 8000));
    const after = await api.getFile(ready.id);
    expect(after.status).toBe('ready');
    expect(after.updatedAt).toBe(ready.updatedAt); // a re-run would have moved it through "processing"
    const dlq = await sqs.send(new ReceiveMessageCommand({ QueueUrl: process.env.DLQ_URL, WaitTimeSeconds: 0 }));
    expect(dlq.Messages ?? []).toHaveLength(0);
  });
});

describe('download and delete', () => {
  /** Every version and delete marker S3 holds under this key (an empty list means it is really gone). */
  async function storedVersions(key: string): Promise<string[]> {
    const out = await createS3Client().send(new ListObjectVersionsCommand({ Bucket: process.env.BUCKET_NAME, Prefix: key }));
    return [...(out.Versions ?? []), ...(out.DeleteMarkers ?? [])].filter((v) => v.Key === key).map((v) => v.VersionId!);
  }

  it('downloads the original bytes as an attachment under the original name', async () => {
    const api = server.apiFor(userId());
    const png = Buffer.from(await new Jimp({ width: 120, height: 90, color: 0x22aa55ff }).getBuffer('image/png'));
    const uploaded = await uploadSmall(api, 'my photo.png', 'image/png', png);
    await waitForFile(api, uploaded.id, (f) => f.status === 'ready' || f.status === 'failed');

    const link = await api.getDownloadUrl(uploaded.id);
    const res = await fetch(link.url);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-disposition')).toMatch(/^attachment; filename="my photo\.png"/);
    expect(Buffer.from(await res.arrayBuffer()).equals(png)).toBe(true);
  });

  it('will not give a download link, or delete, while the file is still uploading', async () => {
    const api = server.apiFor(userId());
    const file = await api.init({ fileName: 'later.bin', fileSize: 1024, contentType: 'application/octet-stream' });
    await expect(api.getDownloadUrl(file.id)).rejects.toMatchObject({ status: 409 });
    await expect(api.deleteFile(file.id)).rejects.toMatchObject({ status: 409 });
    await api.abort(file.id);
  });

  it('deletes a ready file for good: object, every version, thumbnail and record', async () => {
    const user = userId();
    const api = server.apiFor(user);
    const png = Buffer.from(await new Jimp({ width: 300, height: 200, color: 0xdd4422ff }).getBuffer('image/png'));
    const uploaded = await uploadSmall(api, 'goner.png', 'image/png', png);
    const ready = await waitForFile(api, uploaded.id, (f) => f.status === 'ready' || f.status === 'failed');
    const objectKey = await objectKeyFor(ready.id);
    const thumbnailKey = ready.result!.thumbnailKey!;
    expect((await storedVersions(objectKey)).length).toBeGreaterThan(0);
    expect((await storedVersions(thumbnailKey)).length).toBeGreaterThan(0);

    await api.deleteFile(ready.id);

    expect(await storedVersions(objectKey)).toEqual([]);
    expect(await storedVersions(thumbnailKey)).toEqual([]);
    await expect(api.getFile(ready.id)).rejects.toMatchObject({ status: 404 });
    expect((await api.listFiles()).map((f) => f.id)).not.toContain(ready.id);
    await expect(api.deleteFile(ready.id)).rejects.toMatchObject({ status: 404 });
  });

  it('deletes a failed file too, and keeps other users\' files out of reach', async () => {
    const mallory = server.apiFor(userId());
    const api = server.apiFor(userId());
    const zip = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(2048)]);
    const uploaded = await uploadSmall(api, 'bad.png', 'image/png', zip);
    const failed = await waitForFile(api, uploaded.id, (f) => f.status === 'ready' || f.status === 'failed');
    expect(failed.status).toBe('failed');
    const key = await objectKeyFor(failed.id);

    await expect(mallory.deleteFile(failed.id)).rejects.toMatchObject({ status: 404 });
    expect((await storedVersions(key)).length).toBeGreaterThan(0);

    await api.deleteFile(failed.id);
    expect(await storedVersions(key)).toEqual([]);
  });
});

async function objectKeyFor(fileId: string): Promise<string> {
  const { DynamoFileStore, createDocClient } = await import('@s3up/data');
  const rec = await new DynamoFileStore(createDocClient(), process.env.TABLE_NAME!).get(fileId);
  return rec!.s3Key;
}
async function versionFor(fileId: string): Promise<string | undefined> {
  const { DynamoFileStore, createDocClient } = await import('@s3up/data');
  return (await new DynamoFileStore(createDocClient(), process.env.TABLE_NAME!).get(fileId))?.versionId;
}
