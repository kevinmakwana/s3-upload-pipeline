import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { MiB } from '@s3up/core';
import { MemoryFileStore } from '@s3up/data';
import request from 'supertest';
import { AppModule } from './app.module';
import { configureApp } from './app.setup';
import { FILES, LOGGER, S3, S3_PRESIGNER } from './common/tokens';
import { JsonLogger } from './common/logger';
import { FakeS3 } from './testing/fake-s3';
import { offlinePresigner, testConfig } from './testing/harness';

let app: NestExpressApplication | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

type Line = Record<string, unknown>;

/** Boots the API with a logger that records lines instead of printing them. */
async function boot(files: MemoryFileStore = new MemoryFileStore()) {
  const lines: string[] = [];
  const moduleRef = await Test.createTestingModule({ imports: [AppModule.register(testConfig)] })
    .overrideProvider(LOGGER)
    .useValue(new JsonLogger('debug', (l) => lines.push(l)))
    .overrideProvider(FILES)
    .useValue(files)
    .overrideProvider(S3)
    .useValue(new FakeS3())
    .overrideProvider(S3_PRESIGNER)
    .useValue(offlinePresigner())
    .compile();
  app = moduleRef.createNestApplication<NestExpressApplication>();
  configureApp(app, testConfig);
  await app.init();
  lines.length = 0; // start-up chatter is not what these tests are about
  const requests = () => lines.map((l) => JSON.parse(l) as Line).filter((l) => l.message === 'request');
  return { http: request(app.getHttpServer()), lines, all: () => lines.map((l) => JSON.parse(l) as Line), requests };
}

describe('request logging', () => {
  it('logs one line per request with an id, the route, status, timing and who made it', async () => {
    const { http, requests } = await boot();
    const res = await http.get('/files').set('x-user-id', 'alice').expect(200);
    const [line, ...more] = requests();
    expect(more).toEqual([]);
    expect(line).toMatchObject({ level: 'info', message: 'request', method: 'GET', path: '/files', status: 200, userId: 'alice' });
    expect(line!.requestId).toBe(res.headers['x-request-id']);
    expect(line!.requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(typeof line!.durationMs).toBe('number');
  });

  it('never logs the query string, so cursors and the like stay out of the logs', async () => {
    const { http, lines, requests } = await boot();
    await http.get('/files?limit=5&cursor=SECRETCURSOR').set('x-user-id', 'alice').expect(400);
    expect(requests()[0]).toMatchObject({ path: '/files', status: 400 });
    expect(lines.join('\n')).not.toContain('SECRETCURSOR');
  });

  it('never logs credentials or request bodies', async () => {
    const { http, lines } = await boot();
    await http.get('/files').set('authorization', 'Bearer TOP.SECRET.TOKEN').expect(401);
    await http
      .post('/uploads')
      .set('x-user-id', 'alice')
      .send({ fileName: 'private-name.mp4', fileSize: 12 * MiB, contentType: 'video/mp4' })
      .expect(201);
    const everything = lines.join('\n');
    expect(everything).not.toContain('TOP.SECRET.TOKEN');
    expect(everything).not.toContain('private-name');
  });

  it('keeps a sensible incoming request id, so a call can be followed across systems, and replaces anything else', async () => {
    const { http, requests } = await boot();
    const kept = await http.get('/files').set('x-user-id', 'alice').set('x-request-id', 'trace-1234.abcd').expect(200);
    expect(kept.headers['x-request-id']).toBe('trace-1234.abcd');
    for (const bad of ['short', 'has spaces in it!!', 'x'.repeat(65), '<script>alert(1)</script>']) {
      const res = await http.get('/files').set('x-user-id', 'alice').set('x-request-id', bad).expect(200);
      expect(res.headers['x-request-id']).not.toBe(bad);
      expect(res.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
    }
    expect(requests()[0]!.requestId).toBe('trace-1234.abcd');
  });

  it('logs unauthenticated and rejected requests too, at warn, with no user', async () => {
    const { http, requests } = await boot();
    await http.get('/files').expect(401);
    await http.get('/files/missing').set('x-user-id', 'alice').expect(404);
    expect(requests()).toMatchObject([
      { level: 'warn', status: 401, userId: null },
      { level: 'warn', status: 404, userId: 'alice' },
    ]);
  });

  it('stays quiet about the health check while it succeeds, and about CORS preflights', async () => {
    const { http, requests } = await boot();
    await http.get('/health').expect(200);
    await http.options('/uploads').set('origin', 'http://localhost:5173').set('access-control-request-method', 'POST').expect(204);
    expect(requests()).toEqual([]);
  });

  it('lets browsers read the request id and Retry-After', async () => {
    const { http } = await boot();
    const res = await http.get('/health').set('origin', 'http://localhost:5173').expect(200);
    expect(res.headers['access-control-expose-headers']).toMatch(/x-request-id/i);
    expect(res.headers['access-control-expose-headers']).toMatch(/retry-after/i);
  });
});

describe('unexpected errors', () => {
  class BrokenStore extends MemoryFileStore {
    override async listByUser(): Promise<never> {
      throw new Error('DynamoDB exploded: table s3up-secret-table');
    }
  }

  it('logs the failure with its stack and the request id, and tells the client nothing about it', async () => {
    const { http, all, requests } = await boot(new BrokenStore());
    const res = await http.get('/files').set('x-user-id', 'alice').expect(500);

    expect(res.body).toEqual({ statusCode: 500, message: 'Internal server error' });
    expect(JSON.stringify(res.body)).not.toContain('exploded');

    const error = all().find((l) => l.message === 'unhandled error')!;
    expect(error).toMatchObject({
      level: 'error',
      method: 'GET',
      path: '/files',
      userId: 'alice',
      status: 500,
      errorName: 'Error',
      errorMessage: 'DynamoDB exploded: table s3up-secret-table',
    });
    expect(error.stack).toEqual(expect.stringContaining('exploded'));
    expect(error.requestId).toBe(res.headers['x-request-id']);
    expect(requests()[0]).toMatchObject({ level: 'error', status: 500, requestId: res.headers['x-request-id'] });
  });

  it('does not log ordinary client errors as failures', async () => {
    const { http, all } = await boot();
    await http.get('/files/missing').set('x-user-id', 'alice').expect(404);
    await http.post('/uploads').set('x-user-id', 'alice').send({}).expect(400);
    expect(all().filter((l) => l.message === 'unhandled error')).toEqual([]);
  });
});
