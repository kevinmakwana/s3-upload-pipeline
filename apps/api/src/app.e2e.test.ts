import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { MiB } from '@s3up/core';
import { MemoryFileStore } from '@s3up/data';
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
