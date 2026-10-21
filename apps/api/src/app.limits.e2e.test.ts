import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { MiB } from '@s3up/core';
import { MemoryFileStore } from '@s3up/data';
import request from 'supertest';
import { AppModule } from './app.module';
import { configureApp } from './app.setup';
import { FILES, S3, S3_PRESIGNER } from './common/tokens';
import type { AppConfig } from './config';
import { FakeS3 } from './testing/fake-s3';
import { offlinePresigner, testConfig } from './testing/harness';

let app: NestExpressApplication | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

/** Boots the API the way main.ts does (same configureApp), with the given config overrides. */
async function boot(over: Partial<AppConfig> = {}) {
  const config: AppConfig = { ...testConfig, ...over };
  const moduleRef = await Test.createTestingModule({ imports: [AppModule.register(config)] })
    .overrideProvider(FILES)
    .useValue(new MemoryFileStore())
    .overrideProvider(S3)
    .useValue(new FakeS3())
    .overrideProvider(S3_PRESIGNER)
    .useValue(offlinePresigner())
    .compile();
  app = moduleRef.createNestApplication<NestExpressApplication>();
  configureApp(app, config);
  await app.init();
  return request(app.getHttpServer());
}

const limits = (over: Partial<AppConfig['rateLimits']>): Partial<AppConfig> => ({ rateLimits: { ...testConfig.rateLimits, ...over } });
const upload = { fileName: 'clip.mp4', fileSize: 12 * MiB, contentType: 'video/mp4' };

describe('security headers and CORS', () => {
  it('sets the usual hardening headers and hides the framework', async () => {
    const res = await (await boot()).get('/health').expect(200);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['strict-transport-security']).toBeDefined();
    expect(res.headers['x-frame-options']).toBeDefined();
    expect(res.headers['x-powered-by']).toBeUndefined();
  });

  it("still answers the browser's preflight for the allowed origin, including the bearer token header", async () => {
    const http = await boot();
    const res = await http
      .options('/uploads')
      .set('origin', 'http://localhost:5173')
      .set('access-control-request-method', 'POST')
      .set('access-control-request-headers', 'authorization,content-type')
      .expect(204);
    expect(res.headers['access-control-allow-origin']).toBe('http://localhost:5173');
    expect(res.headers['access-control-allow-headers']).toMatch(/authorization/i);
  });

  it('gives other origins no CORS permission', async () => {
    const res = await (await boot()).get('/health').set('origin', 'https://evil.example').expect(200);
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });
});

describe('rate limiting', () => {
  it('limits each caller separately, and says when to come back', async () => {
    const http = await boot(limits({ callerPerMinute: 5 }));
    for (let i = 0; i < 5; i++) await http.get('/files').set('x-user-id', 'alice').expect(200);
    const refused = await http.get('/files').set('x-user-id', 'alice').expect(429);
    expect(Number(refused.headers['retry-after'])).toBeGreaterThan(0);
    expect(JSON.stringify(refused.body)).toMatch(/too many requests/i);
    await http.get('/files').set('x-user-id', 'bob').expect(200); // someone else is not affected
  });

  it('holds bearer-token callers to the limit too, whatever the user id', async () => {
    const http = await boot(limits({ callerPerMinute: 2 }));
    const token = 'a.b.c';
    await http.get('/files').set('authorization', `Bearer ${token}`).expect(401); // not a valid token, still counted
    await http.get('/files').set('authorization', `Bearer ${token}`).expect(401);
    await http.get('/files').set('authorization', `Bearer ${token}`).expect(429);
  });

  it('is stricter about starting uploads than about everything else', async () => {
    const http = await boot(limits({ initPerMinute: 2 }));
    await http.post('/uploads').set('x-user-id', 'alice').send(upload).expect(201);
    await http.post('/uploads').set('x-user-id', 'alice').send(upload).expect(201);
    await http.post('/uploads').set('x-user-id', 'alice').send(upload).expect(429);
    await http.get('/files').set('x-user-id', 'alice').expect(200);
    await http.post('/uploads').set('x-user-id', 'bob').send(upload).expect(201);
  });

  it('never throttles the health check', async () => {
    const http = await boot(limits({ ipPerMinute: 2, callerPerMinute: 2 }));
    for (let i = 0; i < 10; i++) await http.get('/health').expect(200);
  });

  it('caps a single address even when every request brings a different bogus identity', async () => {
    const http = await boot(limits({ ipPerMinute: 4 }));
    for (let i = 0; i < 4; i++) await http.get('/files').set('authorization', `Bearer x${i}.y${i}.z${i}`).expect(401);
    await http.get('/files').set('authorization', 'Bearer x9.y9.z9').expect(429);
  });
});

describe('who the client is behind a load balancer', () => {
  it('ignores X-Forwarded-For unless told to trust a proxy, so it cannot be used to dodge the limit', async () => {
    const http = await boot({ ...limits({ ipPerMinute: 3 }), trustProxyHops: 0 });
    for (let i = 0; i < 3; i++) await http.get('/files').set('x-forwarded-for', `10.0.0.${i}`).expect(401);
    await http.get('/files').set('x-forwarded-for', '10.0.0.99').expect(429);
  });

  it('with one trusted proxy, tells clients apart by the address that proxy appended', async () => {
    const http = await boot({ ...limits({ ipPerMinute: 2 }), trustProxyHops: 1 });
    for (let i = 0; i < 4; i++) await http.get('/files').set('x-forwarded-for', `203.0.113.${i}`).expect(401); // four different clients
    await http.get('/files').set('x-forwarded-for', '198.51.100.7').expect(401);
    await http.get('/files').set('x-forwarded-for', '198.51.100.7').expect(401);
    await http.get('/files').set('x-forwarded-for', '198.51.100.7').expect(429); // the same client
  });

  it('with one trusted proxy, a client cannot hide behind addresses it made up', async () => {
    const http = await boot({ ...limits({ ipPerMinute: 2 }), trustProxyHops: 1 });
    // The proxy appends the real address ("198.51.100.7") after whatever the client sent.
    await http.get('/files').set('x-forwarded-for', 'fake-1, 198.51.100.7').expect(401);
    await http.get('/files').set('x-forwarded-for', 'fake-2, 198.51.100.7').expect(401);
    await http.get('/files').set('x-forwarded-for', 'fake-3, 198.51.100.7').expect(429);
  });
});
