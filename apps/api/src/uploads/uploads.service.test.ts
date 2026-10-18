import { BadRequestException, ConflictException, GoneException, NotFoundException, PayloadTooLargeException, UnprocessableEntityException } from '@nestjs/common';
import { CreateMultipartUploadCommand } from '@aws-sdk/client-s3';
import { MiB, parseObjectKey, partRange } from '@s3up/core';
import { makeService } from '../testing/harness';

const SHA = Buffer.alloc(32, 1).toString('base64');
const init = (over = {}) => ({ fileName: 'movie.mp4', fileSize: 12 * MiB, contentType: 'video/mp4', ...over });

async function startUpload(ctx = makeService(), user = 'alice', req = init()) {
  const file = await ctx.service.init(user, req);
  const record = (await ctx.files.get(file.id))!;
  return { ...ctx, file, record, uploadId: record.s3UploadId };
}

/** Puts every planned part into the fake S3, as a finished browser upload would. */
function putAllParts(ctx: Awaited<ReturnType<typeof startUpload>>) {
  const plan = { fileSize: ctx.record.size, partSize: ctx.record.partSize, partCount: ctx.record.partCount };
  for (let n = 1; n <= plan.partCount; n++) ctx.s3.putPart(ctx.uploadId, n, partRange(plan, n).size);
}

describe('init', () => {
  it('opens a SHA-256 multipart upload under the user prefix and records it', async () => {
    const ctx = await startUpload();
    expect(ctx.file).toMatchObject({ status: 'uploading', partSize: 5 * MiB, partCount: 3, size: 12 * MiB });
    expect(parseObjectKey(ctx.record.s3Key)).toMatchObject({ userId: 'alice', fileId: ctx.file.id });
    const create = ctx.s3.commands.find((c) => c instanceof CreateMultipartUploadCommand) as CreateMultipartUploadCommand;
    expect(create.input).toMatchObject({ Bucket: 'test-bucket', ChecksumAlgorithm: 'SHA256', ContentType: 'video/mp4' });
    expect(ctx.record.expiresAt).toBeGreaterThan(Date.now() / 1000);
  });

  it.each([
    ['disallowed type', init({ contentType: 'application/x-msdownload', fileName: 'a.exe' })],
    ['extension mismatch', init({ fileName: 'movie.exe' })],
    ['empty file', init({ fileSize: 0 })],
    ['too large', init({ fileSize: 2048 * MiB })],
  ])('rejects %s and creates nothing', async (_name, req) => {
    const ctx = makeService();
    await expect(ctx.service.init('alice', req)).rejects.toBeInstanceOf(BadRequestException);
    expect(ctx.s3.uploads.size).toBe(0);
    expect(ctx.files.records.size).toBe(0);
  });

  it('keeps hostile file names inside the user prefix', async () => {
    const ctx = await startUpload(makeService(), 'alice', init({ fileName: '../../bob/movie.mp4' }));
    expect(ctx.record.s3Key.startsWith('uploads/alice/')).toBe(true);
    expect(ctx.record.s3Key.endsWith('/movie.mp4')).toBe(true);
  });
});

describe('per-user quotas', () => {
  const quotas = (over: Partial<{ maxActiveUploads: number; maxStoredBytes: number }> = {}) => makeService({ quotas: { maxActiveUploads: 0, maxStoredBytes: 0, ...over } });

  it('stops a user starting more uploads than the limit, with a conflict that says what to do', async () => {
    const ctx = quotas({ maxActiveUploads: 2 });
    await ctx.service.init('alice', init());
    const second = await ctx.service.init('alice', init());
    const err = await ctx.service.init('alice', init()).catch((e) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect(err.message).toMatch(/2 uploads in progress.*limit is 2/i);
    expect(ctx.s3.uploads.size).toBe(2); // nothing was opened in S3 for the refused request

    await ctx.service.abort('alice', second.id); // cancelling frees a slot
    await expect(ctx.service.init('alice', init())).resolves.toMatchObject({ status: 'uploading' });
  });

  it('counts only the caller\'s own uploads, and finished ones do not occupy a slot', async () => {
    const ctx = quotas({ maxActiveUploads: 1 });
    const done = await ctx.service.init('alice', init());
    await ctx.files.markProcessing(done.id, new Date().toISOString());
    await ctx.files.markReady(done.id, { sha256: 'a', size: done.size }, new Date().toISOString());
    await expect(ctx.service.init('alice', init())).resolves.toBeDefined();
    await expect(ctx.service.init('bob', init())).resolves.toBeDefined();
    await expect(ctx.service.init('alice', init())).rejects.toBeInstanceOf(ConflictException);
  });

  it('refuses a file that would take a user over their storage quota, and allows one that exactly fits', async () => {
    const ctx = quotas({ maxStoredBytes: 30 * MiB });
    await ctx.service.init('alice', init({ fileSize: 12 * MiB }));
    await ctx.service.init('alice', init({ fileSize: 12 * MiB }));
    const err = await ctx.service.init('alice', init({ fileSize: 7 * MiB })).catch((e) => e);
    expect(err).toBeInstanceOf(PayloadTooLargeException);
    expect(err.message).toMatch(/quota/i);
    expect(ctx.s3.uploads.size).toBe(2);
    await expect(ctx.service.init('alice', init({ fileSize: 6 * MiB }))).resolves.toBeDefined(); // 12 + 12 + 6 = 30
    await expect(ctx.service.init('bob', init({ fileSize: 12 * MiB }))).resolves.toBeDefined();
  });

  it('gives the space back when an upload is cancelled or a file is deleted', async () => {
    const ctx = quotas({ maxStoredBytes: 12 * MiB });
    const first = await ctx.service.init('alice', init());
    await expect(ctx.service.init('alice', init())).rejects.toBeInstanceOf(PayloadTooLargeException);
    await ctx.service.abort('alice', first.id);
    await expect(ctx.service.init('alice', init())).resolves.toBeDefined();
  });

  it('turns each limit off with 0', async () => {
    const ctx = quotas();
    for (let i = 0; i < 25; i++) await ctx.service.init('alice', init({ fileSize: 500 * MiB }));
    expect(ctx.s3.uploads.size).toBe(25);
  });
});

describe('presignPart scoping', () => {
  it('signs a short-lived PUT for exactly one key, upload and part', async () => {
    const ctx = await startUpload();
    const res = await ctx.service.presignPart('alice', ctx.file.id, 2, SHA);
    const url = new URL(res.url);
    expect(res.method).toBe('PUT');
    expect(url.pathname).toBe(`/test-bucket/${ctx.record.s3Key.split('/').map(encodeURIComponent).join('/')}`);
    expect(url.searchParams.get('uploadId')).toBe(ctx.uploadId);
    expect(url.searchParams.get('partNumber')).toBe('2');
    expect(url.searchParams.get('X-Amz-Expires')).toBe('900');
    expect(url.searchParams.get('X-Amz-Signature')).toMatch(/^[0-9a-f]{64}$/);
    expect(Date.parse(res.expiresAt) - Date.now()).toBeLessThanOrEqual(900_000);
  });

  it('binds the checksum header and content length into the signature', async () => {
    const ctx = await startUpload();
    const res = await ctx.service.presignPart('alice', ctx.file.id, 1, SHA);
    const signed = new URL(res.url).searchParams.get('X-Amz-SignedHeaders')!.split(';');
    expect(signed).toEqual(expect.arrayContaining(['host', 'x-amz-checksum-sha256', 'content-length']));
    expect(res.headers).toEqual({ 'x-amz-checksum-sha256': SHA });
  });

  it('gives different signatures per part and per checksum', async () => {
    const ctx = await startUpload();
    const sig = async (n: number, sha = SHA) => new URL((await ctx.service.presignPart('alice', ctx.file.id, n, sha)).url).searchParams.get('X-Amz-Signature');
    expect(await sig(1)).not.toBe(await sig(2));
    expect(await sig(1)).not.toBe(await sig(1, Buffer.alloc(32, 2).toString('base64')));
  });

  it('honours a configured expiry and clamps nothing below it', async () => {
    const ctx = await startUpload(makeService({ presignExpiresSeconds: 120 }));
    const url = new URL((await ctx.service.presignPart('alice', ctx.file.id, 1, SHA)).url);
    expect(url.searchParams.get('X-Amz-Expires')).toBe('120');
  });

  it("refuses to sign for someone else's upload (it looks like a missing one)", async () => {
    const ctx = await startUpload();
    await expect(ctx.service.presignPart('mallory', ctx.file.id, 1, SHA)).rejects.toBeInstanceOf(NotFoundException);
    await expect(ctx.service.presignPart('alice', 'no-such-id', 1, SHA)).rejects.toBeInstanceOf(NotFoundException);
  });

  it.each([0, 4, -1, 1.5, Number.NaN])('rejects part number %s', async (n) => {
    const ctx = await startUpload();
    await expect(ctx.service.presignPart('alice', ctx.file.id, n, SHA)).rejects.toBeInstanceOf(BadRequestException);
  });

  it.each(['', 'abc', 'not base64 !!!', `${SHA}x`])('rejects malformed checksum %j', async (sha) => {
    const ctx = await startUpload();
    await expect(ctx.service.presignPart('alice', ctx.file.id, 1, sha)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('stops signing once the upload is no longer open', async () => {
    const ctx = await startUpload();
    await ctx.service.abort('alice', ctx.file.id);
    await expect(ctx.service.presignPart('alice', ctx.file.id, 1, SHA)).rejects.toBeInstanceOf(ConflictException);
  });
});

describe('listParts', () => {
  it('returns what S3 holds, following pagination', async () => {
    const ctx = await startUpload();
    ctx.s3.listPageSize = 1;
    putAllParts(ctx);
    const res = await ctx.service.listParts('alice', ctx.file.id);
    expect(res.parts.map((p) => p.partNumber)).toEqual([1, 2, 3]);
    expect(res.parts[2]!.size).toBe(2 * MiB);
    expect(res.parts[0]!.sha256).toBeDefined();
  });

  it('is empty (and cheap) once the upload has left the uploading state', async () => {
    const ctx = await startUpload();
    putAllParts(ctx);
    await ctx.service.complete('alice', ctx.file.id);
    expect(await ctx.service.listParts('alice', ctx.file.id)).toMatchObject({ file: { status: 'uploaded' }, parts: [] });
  });

  it('reports 410 Gone when the multipart upload expired in S3', async () => {
    const ctx = await startUpload();
    ctx.s3.uploads.clear();
    await expect(ctx.service.listParts('alice', ctx.file.id)).rejects.toBeInstanceOf(GoneException);
  });

  it("hides other users' uploads", async () => {
    const ctx = await startUpload();
    await expect(ctx.service.listParts('mallory', ctx.file.id)).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('complete', () => {
  it('verifies the final ETag and marks the file uploaded', async () => {
    const ctx = await startUpload();
    putAllParts(ctx);
    const file = await ctx.service.complete('alice', ctx.file.id);
    expect(file.status).toBe('uploaded');
    const rec = (await ctx.files.get(ctx.file.id))!;
    expect(rec.etag).toMatch(/^[0-9a-f]{32}-3$/);
    expect(rec.versionId).toBe('v1');
    expect(rec.expiresAt).toBeUndefined();
  });

  it('is idempotent when the client retries after success', async () => {
    const ctx = await startUpload();
    putAllParts(ctx);
    await ctx.service.complete('alice', ctx.file.id);
    expect((await ctx.service.complete('alice', ctx.file.id)).status).toBe('uploaded');
  });

  it('refuses when parts are missing and names them', async () => {
    const ctx = await startUpload();
    ctx.s3.putPart(ctx.uploadId, 1, 5 * MiB);
    const err = await ctx.service.complete('alice', ctx.file.id).catch((e) => e);
    expect(err).toBeInstanceOf(BadRequestException);
    expect(err.getResponse()).toMatchObject({ missingParts: [2, 3] });
    expect((await ctx.files.get(ctx.file.id))!.status).toBe('uploading');
  });

  it('refuses parts of the wrong size', async () => {
    const ctx = await startUpload();
    ctx.s3.putPart(ctx.uploadId, 1, 5 * MiB);
    ctx.s3.putPart(ctx.uploadId, 2, 5 * MiB - 1);
    ctx.s3.putPart(ctx.uploadId, 3, 2 * MiB);
    const err = await ctx.service.complete('alice', ctx.file.id).catch((e) => e);
    expect(err.getResponse()).toMatchObject({ wrongSizeParts: [2] });
  });

  it('deletes the object and fails the file when the final ETag does not match', async () => {
    const ctx = await startUpload();
    putAllParts(ctx);
    ctx.s3.corruptEtag = true;
    await expect(ctx.service.complete('alice', ctx.file.id)).rejects.toBeInstanceOf(UnprocessableEntityException);
    expect(ctx.s3.deleted).toHaveLength(1);
    expect(await ctx.files.get(ctx.file.id)).toMatchObject({ status: 'failed', error: expect.stringContaining('Integrity check failed') });
  });

  it('cannot complete an upload that was aborted', async () => {
    const ctx = await startUpload();
    await ctx.service.abort('alice', ctx.file.id);
    await expect(ctx.service.complete('alice', ctx.file.id)).rejects.toBeInstanceOf(ConflictException);
  });
});

describe('abort', () => {
  it('aborts in S3 and marks the record, idempotently', async () => {
    const ctx = await startUpload();
    await ctx.service.abort('alice', ctx.file.id);
    expect(ctx.s3.uploads.size).toBe(0);
    expect((await ctx.files.get(ctx.file.id))!.status).toBe('aborted');
    await expect(ctx.service.abort('alice', ctx.file.id)).resolves.toBeUndefined();
  });

  it('tolerates an upload that S3 already expired', async () => {
    const ctx = await startUpload();
    ctx.s3.uploads.clear();
    await ctx.service.abort('alice', ctx.file.id);
    expect((await ctx.files.get(ctx.file.id))!.status).toBe('aborted');
  });

  it('cannot abort a finished upload or one that is not yours', async () => {
    const ctx = await startUpload();
    putAllParts(ctx);
    await expect(ctx.service.abort('mallory', ctx.file.id)).rejects.toBeInstanceOf(NotFoundException);
    await ctx.service.complete('alice', ctx.file.id);
    await expect(ctx.service.abort('alice', ctx.file.id)).rejects.toBeInstanceOf(ConflictException);
  });
});
