import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE, MiB } from '@s3up/core';
import { MemoryFileStore, type FileRecord } from '@s3up/data';
import request from 'supertest';
import { AppModule } from './app.module';
import { FILES, S3, S3_PRESIGNER } from './common/tokens';
import { FakeS3 } from './testing/fake-s3';
import { offlinePresigner, testConfig } from './testing/harness';

describe('HTTP API', () => {
  let app: INestApplication;
  let files: MemoryFileStore;
  let s3: FakeS3;

  beforeEach(async () => {
    files = new MemoryFileStore();
    s3 = new FakeS3();
    const moduleRef = await Test.createTestingModule({ imports: [AppModule.register(testConfig)] })
      .overrideProvider(FILES).useValue(files)
      .overrideProvider(S3).useValue(s3)
      .overrideProvider(S3_PRESIGNER).useValue(offlinePresigner())
      .compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });
  afterEach(() => app.close());

  const body = { fileName: 'clip.mp4', fileSize: 12 * MiB, contentType: 'video/mp4' };

  it('requires a valid x-user-id on every data route', async () => {
    await request(app.getHttpServer()).post('/uploads').send(body).expect(401);
    await request(app.getHttpServer()).get('/files').expect(401);
    await request(app.getHttpServer()).get('/files').set('x-user-id', '../etc').expect(401);
    await request(app.getHttpServer()).get('/health').expect(200);
  });

  it('validates the request body', async () => {
    const res = await request(app.getHttpServer()).post('/uploads').set('x-user-id', 'alice').send({ fileName: 'x', fileSize: 'big' }).expect(400);
    expect(JSON.stringify(res.body)).toMatch(/fileSize/);
  });

  it('runs the whole API flow and isolates users from each other', async () => {
    const http = request(app.getHttpServer());
    const init = await http.post('/uploads').set('x-user-id', 'alice').send(body).expect(201);
    const id = init.body.file.id as string;
    expect(init.body.file).toMatchObject({ status: 'uploading', partCount: 3 });

    const presign = await http.post(`/uploads/${id}/parts/1/presign`).set('x-user-id', 'alice').send({ sha256: Buffer.alloc(32, 9).toString('base64') }).expect(200);
    expect(presign.body.url).toContain('partNumber=1');
    await http.post(`/uploads/${id}/parts/9/presign`).set('x-user-id', 'alice').send({ sha256: Buffer.alloc(32, 9).toString('base64') }).expect(400);
    await http.post(`/uploads/${id}/parts/x/presign`).set('x-user-id', 'alice').send({ sha256: 'x' }).expect(400);

    await http.get(`/uploads/${id}/parts`).set('x-user-id', 'mallory').expect(404);
    await http.get(`/files/${id}`).set('x-user-id', 'mallory').expect(404);
    await http.post(`/uploads/${id}/complete`).set('x-user-id', 'mallory').expect(404);
    await http.delete(`/uploads/${id}`).set('x-user-id', 'mallory').expect(404);

    const list = await http.get('/files').set('x-user-id', 'alice').expect(200);
    expect(list.body.files.map((f: { id: string }) => f.id)).toEqual([id]);
    expect((await http.get('/files').set('x-user-id', 'mallory').expect(200)).body.files).toEqual([]);

    await http.post(`/uploads/${id}/complete`).set('x-user-id', 'alice').expect(400); // no parts yet
    await http.delete(`/uploads/${id}`).set('x-user-id', 'alice').expect(204);
    expect((await http.get('/files').set('x-user-id', 'alice')).body.files).toEqual([]); // aborted hidden
  });

  describe('GET /files paging', () => {
    const stamp = (n: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, n)).toISOString();
    async function seed(userId: string, count: number, aborted: number[] = []) {
      const ids: string[] = [];
      for (let n = 1; n <= count; n++) {
        const id = `file-${userId}-${String(n).padStart(3, '0')}`;
        const record: FileRecord = {
          id, userId, fileName: `f${n}.bin`, contentType: 'application/octet-stream', size: 10, status: aborted.includes(n) ? 'aborted' : 'uploading',
          partSize: 5 * MiB, partCount: 1, s3Key: `uploads/${userId}/${id}/f${n}.bin`, s3UploadId: 'u', createdAt: stamp(n), updatedAt: stamp(n),
        };
        await files.create(record);
        if (!aborted.includes(n)) ids.push(id);
      }
      return ids.reverse(); // newest first
    }
    const get = (query: string, user = 'alice') => request(app.getHttpServer()).get(`/files${query}`).set('x-user-id', user);
    const idsOf = (res: request.Response) => (res.body.files as { id: string }[]).map((f) => f.id);

    it('returns the default page size with a cursor when there is more', async () => {
      const ids = await seed('alice', DEFAULT_PAGE_SIZE + 5);
      const res = await get('').expect(200);
      expect(idsOf(res)).toEqual(ids.slice(0, DEFAULT_PAGE_SIZE));
      expect(res.body.nextCursor).toEqual(expect.any(String));
    });

    it('walks the whole list page by page, newest first, hiding aborted uploads without short pages', async () => {
      const ids = await seed('alice', 9, [2, 3, 9]);
      const seen: string[] = [];
      let cursor: string | undefined;
      const sizes: number[] = [];
      do {
        const res = await get(`?limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`).expect(200);
        sizes.push(res.body.files.length);
        seen.push(...idsOf(res));
        cursor = res.body.nextCursor;
      } while (cursor);
      expect(seen).toEqual(ids);
      expect(sizes).toEqual([2, 2, 2]);
    });

    it('omits nextCursor when everything fits on one page', async () => {
      await seed('alice', 3);
      const res = await get('?limit=3').expect(200);
      expect(res.body.files).toHaveLength(3);
      expect(res.body).not.toHaveProperty('nextCursor');
    });

    it.each([['limit=0'], [`limit=${MAX_PAGE_SIZE + 1}`], ['limit=abc'], ['limit=1.5'], ['cursor=garbage'], ['cursor=']])(
      'rejects bad paging parameters (%s) with 400',
      async (query) => {
        await get(`?${query}`).expect(400);
      },
    );

    it('keeps users apart: a cursor from one user cannot read another user\'s files', async () => {
      await seed('alice', 4);
      const bob = await seed('bob', 2);
      const { nextCursor } = (await get('?limit=1')).body;
      const res = await get(`?cursor=${encodeURIComponent(nextCursor)}`, 'bob').expect(200);
      expect(idsOf(res).every((id) => bob.includes(id))).toBe(true);
    });

    it('pushes only the newest page over SSE, with a cursor for the rest', async () => {
      const ids = await seed('alice', DEFAULT_PAGE_SIZE + 3);
      await new Promise<void>((resolve, reject) => {
        const server = app.getHttpServer().listen(0, async () => {
          const port = (server.address() as { port: number }).port;
          const controller = new AbortController();
          const timeout = setTimeout(() => reject(new Error('SSE timed out')), 5000);
          try {
            const res = await fetch(`http://127.0.0.1:${port}/files/stream`, { headers: { 'x-user-id': 'alice' }, signal: controller.signal });
            const reader = res.body!.getReader();
            const dec = new TextDecoder();
            let buf = '';
            while (!buf.includes('\n\n')) buf += dec.decode((await reader.read()).value);
            const data = JSON.parse(/^data: (.*)$/m.exec(buf)![1]!) as { files: { id: string }[]; nextCursor?: string };
            expect(data.files.map((f) => f.id)).toEqual(ids.slice(0, DEFAULT_PAGE_SIZE));
            expect(data.nextCursor).toEqual(expect.any(String));
            resolve();
          } catch (e) {
            reject(e);
          } finally {
            clearTimeout(timeout);
            controller.abort();
            server.close();
          }
        });
      });
    });
  });

  describe('download and delete a finished file', () => {
    const KEY = (id: string) => `uploads/alice/${id}/Quarterly "report".pdf`;
    const THUMB = (id: string) => `thumbnails/alice/${id}.jpg`;
    async function finished(status: FileRecord['status'] = 'ready', userId = 'alice') {
      const id = `file-${Math.random().toString(36).slice(2, 10)}`;
      const record: FileRecord = {
        id, userId, fileName: 'Quarterly "report".pdf', contentType: 'application/pdf', size: 10, status, partSize: 5 * MiB, partCount: 1,
        s3Key: KEY(id), s3UploadId: 'u', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', versionId: 'v-main',
        ...(status === 'ready' ? { result: { sha256: 'ab', size: 10, thumbnailKey: THUMB(id) } } : {}),
      };
      await files.create(record);
      s3.addVersion(KEY(id), 'v-main');
      return record;
    }
    const as = (user: string) => ({ get: (p: string) => request(app.getHttpServer()).get(p).set('x-user-id', user), del: (p: string) => request(app.getHttpServer()).delete(p).set('x-user-id', user) });

    it('hands out a short-lived link for the stored version that forces a download', async () => {
      const r = await finished();
      const res = await as('alice').get(`/files/${r.id}/download`).expect(200);
      const url = new URL(res.body.url);
      expect(decodeURIComponent(url.pathname)).toContain(KEY(r.id));
      expect(url.searchParams.get('versionId')).toBe('v-main');
      expect(url.searchParams.get('X-Amz-Expires')).toBe('300');
      expect(url.searchParams.get('response-content-disposition')).toMatch(/^attachment; filename="Quarterly _report_\.pdf"; filename\*=UTF-8''/);
      expect(url.searchParams.get('response-content-type')).toBe('application/pdf');
      expect(Date.parse(res.body.expiresAt)).toBeGreaterThan(Date.now());
    });

    it.each([['uploading'], ['uploaded'], ['processing'], ['failed']] as const)('refuses to hand out a download for a %s file', async (status) => {
      const r = await finished(status);
      await as('alice').get(`/files/${r.id}/download`).expect(409);
    });

    it('treats another user\'s file, or an unknown one, as not found', async () => {
      const r = await finished();
      await as('mallory').get(`/files/${r.id}/download`).expect(404);
      await as('alice').get('/files/nope/download').expect(404);
    });

    it('deletes every version, delete marker and thumbnail, then the record, but nothing else', async () => {
      const r = await finished();
      s3.addVersion(KEY(r.id), 'v-old');
      s3.addVersion(KEY(r.id), 'v-marker', true);
      s3.addVersion(THUMB(r.id), 't1');
      s3.addVersion(THUMB(r.id), 't2');
      const sibling = `${KEY(r.id)}.bak`; // shares the key as a prefix, must survive
      s3.addVersion(sibling, 's1');
      s3.versionPageSize = 2; // force the listing to take several pages

      await as('alice').del(`/files/${r.id}`).expect(204);

      expect(s3.versionsOf(KEY(r.id))).toEqual([]);
      expect(s3.versionsOf(THUMB(r.id))).toEqual([]);
      expect(s3.versionsOf(sibling)).toEqual(['s1']);
      expect(await files.get(r.id)).toBeUndefined();
      expect((await as('alice').get('/files')).body.files).toEqual([]);
      await as('alice').get(`/files/${r.id}`).expect(404);
      await as('alice').del(`/files/${r.id}`).expect(404); // already gone
    });

    it('deletes a failed file too (nothing to clean up but the record and object)', async () => {
      const r = await finished('failed');
      await as('alice').del(`/files/${r.id}`).expect(204);
      expect(s3.versionsOf(KEY(r.id))).toEqual([]);
      expect(await files.get(r.id)).toBeUndefined();
    });

    it.each([['uploading'], ['uploaded'], ['processing']] as const)('will not delete a %s file', async (status) => {
      const r = await finished(status);
      await as('alice').del(`/files/${r.id}`).expect(409);
      expect(s3.versionsOf(KEY(r.id))).toEqual(['v-main']);
      expect((await files.get(r.id))?.status).toBe(status);
    });

    it('still shows an aborted upload by id (status "aborted"), but offers it no download or delete', async () => {
      const r = await finished('uploading');
      await files.markAborted(r.id, new Date().toISOString());
      expect((await as('alice').get(`/files/${r.id}`).expect(200)).body.status).toBe('aborted');
      await as('alice').get(`/files/${r.id}/download`).expect(404);
      await as('alice').del(`/files/${r.id}`).expect(404);
    });

    it('does not let another user delete a file', async () => {
      const r = await finished();
      await as('mallory').del(`/files/${r.id}`).expect(404);
      expect(s3.versionsOf(KEY(r.id))).toEqual(['v-main']);
      expect(await files.get(r.id)).toBeDefined();
    });

    it('keeps the record when S3 refuses to delete, so the request can be retried', async () => {
      const r = await finished();
      s3.failDeleteKeys.add(KEY(r.id));
      await as('alice').del(`/files/${r.id}`).expect(500);
      expect(await files.get(r.id)).toBeDefined();
      s3.failDeleteKeys.clear();
      await as('alice').del(`/files/${r.id}`).expect(204);
      expect(await files.get(r.id)).toBeUndefined();
    });
  });

  it('streams file state over SSE and pushes updates', async () => {
    const http = request(app.getHttpServer());
    const init = await http.post('/uploads').set('x-user-id', 'alice').send(body).expect(201);
    const id = init.body.file.id as string;
    await new Promise<void>((resolve, reject) => {
      const server = app.getHttpServer().listen(0, async () => {
        const port = (server.address() as { port: number }).port;
        const controller = new AbortController();
        const timeout = setTimeout(() => reject(new Error('SSE timed out')), 5000);
        const res = await fetch(`http://127.0.0.1:${port}/files/stream`, { headers: { 'x-user-id': 'alice' }, signal: controller.signal });
        expect(res.headers.get('content-type')).toMatch(/text\/event-stream/);
        const reader = res.body!.getReader();
        const dec = new TextDecoder();
        let buf = '';
        let sawUploading = false;
        try {
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            buf += dec.decode(value);
            if (!sawUploading && buf.includes('"status":"uploading"')) {
              sawUploading = true;
              await files.markProcessing(id, new Date().toISOString());
            }
            if (buf.includes('"status":"processing"')) break;
          }
          expect(sawUploading).toBe(true);
          expect(buf).toContain('event: files');
          resolve();
        } catch (e) {
          reject(e);
        } finally {
          clearTimeout(timeout);
          controller.abort();
          server.close();
        }
      });
    });
  });
});
