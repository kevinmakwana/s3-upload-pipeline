import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Jimp } from 'jimp';
import { MemoryResumeStore, MiB, Upload, type FileDto, type UploadOptions } from '@s3up/core';
import { FetchTransport, NodeFileSource, startApi, waitForFile, type RunningApi } from '../integration/harness';
import { assumeApiPolicy, type Restricted } from './api-role';

/**
 * Runs against a stack deployed to real AWS, through the real API code, with the AWS behaviour LocalStack
 * only imitates: S3 multipart checksums and CORS-free presigned PUTs, the worker's own IAM role, and (unless
 * SMOKE_FULL_ACCESS=true) the API running with nothing but the stack's ApiPolicy.
 *
 * SMOKE_MALWARE=true also uploads the EICAR test string and expects the scan to quarantine it. That needs a
 * stack deployed with -c malwareScan=true.
 */
const fast: Partial<UploadOptions> = { concurrency: 4, maxRetries: 3, baseDelayMs: 100, maxDelayMs: 1000 };
const SCAN = process.env.SMOKE_MALWARE === 'true';
/** The industry-standard harmless test file every antivirus engine flags. */
const EICAR = 'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*';

let server: RunningApi;
let restricted: Restricted | undefined;
let dir: string;
const saved: Record<string, string | undefined> = {};
const created: string[] = [];
const user = `smoke-${randomBytes(4).toString('hex')}`;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 's3up-smoke-'));
  if (process.env.SMOKE_FULL_ACCESS !== 'true') {
    if (!process.env.API_POLICY_ARN)
      throw new Error('The stack outputs have no ApiPolicyArn; redeploy, or set SMOKE_FULL_ACCESS=true to skip the permission check.');
    restricted = await assumeApiPolicy(process.env.API_POLICY_ARN);
    for (const [k, v] of Object.entries(restricted.env)) {
      saved[k] = process.env[k];
      process.env[k] = v;
    }
    delete process.env.AWS_PROFILE;
  }
  server = await startApi({ PART_SIZE_BYTES: String(5 * MiB), ...(SCAN ? { MALWARE_SCAN: 'true' } : {}) });
}, 120_000);

afterAll(async () => {
  const api = server?.apiFor(user);
  for (const id of created) await api?.deleteFile(id).catch(() => undefined);
  await server?.close();
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  await restricted?.cleanup();
  await rm(dir, { recursive: true, force: true });
}, 120_000);

async function upload(name: string, contentType: string, bytes: Buffer): Promise<FileDto> {
  const path = join(dir, `${randomBytes(4).toString('hex')}-${name}`);
  await writeFile(path, bytes);
  const source = await NodeFileSource.open(path);
  const out = await new Upload(
    { api: server.apiFor(user), transport: new FetchTransport(), store: new MemoryResumeStore() },
    source,
    { fileName: name, contentType, lastModified: 1 },
    fast,
  ).start();
  await source.close();
  if (out.type !== 'done') throw new Error(`upload ended ${out.type}`);
  created.push(out.file.id);
  return out.file;
}

const sha256 = (b: Buffer) => createHash('sha256').update(b).digest('hex');

describe('real AWS', () => {
  it('uploads a multipart file in parts, processes it, and serves it back byte for byte', async () => {
    const bytes = randomBytes(11 * MiB); // three parts: 5 + 5 + 1 MiB
    const file = await upload('smoke.bin', 'application/octet-stream', bytes);
    expect(file.partCount).toBe(3);

    const api = server.apiFor(user);
    const ready = await waitForFile(api, file.id, (f) => f.status === 'ready' || f.status === 'failed' || f.status === 'quarantined', 5 * 60_000);
    expect(ready.error).toBeUndefined();
    expect(ready.status).toBe('ready');
    expect(ready.result).toMatchObject({ sha256: sha256(bytes), size: bytes.length });

    const link = await downloadWhenAllowed(api, file.id);
    const res = await fetch(link);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-disposition')).toMatch(/^attachment; filename="smoke\.bin"/);
    expect(sha256(Buffer.from(await res.arrayBuffer()))).toBe(sha256(bytes));
  });

  it('makes a thumbnail of an image and serves it through a presigned link', async () => {
    const image = new Jimp({ width: 640, height: 480, color: 0x3366ccff });
    const png = Buffer.from(await image.getBuffer('image/png'));
    const file = await upload('photo.png', 'image/png', png);
    const ready = await waitForFile(server.apiFor(user), file.id, (f) => f.status === 'ready' || f.status === 'failed', 5 * 60_000);
    expect(ready.status).toBe('ready');
    expect(ready.result).toMatchObject({ width: 640, height: 480 });
    expect(ready.thumbnailUrl).toBeDefined();
    const thumb = await fetch(ready.thumbnailUrl!);
    expect(thumb.status).toBe(200);
    expect(thumb.headers.get('content-type')).toMatch(/image\/jpeg/);
  });

  it('deletes a finished file: the record goes and the download link stops working', async () => {
    const file = await upload('gone.txt', 'text/plain', Buffer.from('delete me\n'));
    const api = server.apiFor(user);
    await waitForFile(api, file.id, (f) => f.status === 'ready', 5 * 60_000);
    const link = await downloadWhenAllowed(api, file.id);
    expect((await fetch(link)).status).toBe(200);
    await api.deleteFile(file.id);
    await expect(api.getFile(file.id)).rejects.toMatchObject({ status: 404 });
    // The link pinned a version that no longer exists.
    expect((await fetch(link)).status).toBe(404);
    created.splice(created.indexOf(file.id), 1);
  });

  (SCAN ? it : it.skip)('quarantines a file GuardDuty flags, and refuses to serve it', async () => {
    const file = await upload('eicar.txt', 'text/plain', Buffer.from(EICAR));
    const api = server.apiFor(user);
    // GuardDuty usually finishes within a minute or two of the upload.
    const final = await waitForFile(api, file.id, (f) => f.status === 'quarantined', 8 * 60_000);
    expect(final.error).toMatch(/Malware found/);
    await expect(api.getDownloadUrl(file.id)).rejects.toMatchObject({ status: 409 });
  });

  (SCAN ? it : it.skip)('waits for a clean verdict before it hands out a download', async () => {
    const file = await upload('clean.txt', 'text/plain', Buffer.from('nothing to see here\n'));
    const api = server.apiFor(user);
    await waitForFile(api, file.id, (f) => f.status === 'ready', 5 * 60_000);
    // Until GuardDuty tags the object the API answers 409; afterwards it answers with a link.
    const link = await downloadWhenAllowed(api, file.id, 8 * 60_000);
    expect((await fetch(link)).status).toBe(200);
  });
});

/** With scanning on, a download is refused until the verdict is in. */
async function downloadWhenAllowed(api: ReturnType<RunningApi['apiFor']>, fileId: string, timeoutMs = 60_000): Promise<string> {
  const start = Date.now();
  for (;;) {
    try {
      return (await api.getDownloadUrl(fileId)).url;
    } catch (err) {
      const status = (err as { status?: number }).status;
      if (!SCAN || status !== 409 || Date.now() - start > timeoutMs) throw err;
      await new Promise((r) => setTimeout(r, 5_000));
    }
  }
}
