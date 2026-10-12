import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { MiB } from '@s3up/core';
import { MemoryFileStore } from '@s3up/data';
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } from 'jose';
import request from 'supertest';
import { AppModule } from './app.module';
import { JwtAuthenticator } from './auth/authenticator';
import { AUTHENTICATOR, FILES, S3, S3_PRESIGNER } from './common/tokens';
import { FakeS3 } from './testing/fake-s3';
import { offlinePresigner, testConfig } from './testing/harness';

describe('HTTP API with JWT authentication', () => {
  let app: INestApplication;
  let sign: (sub: string, over?: { aud?: string }) => Promise<string>;

  beforeEach(async () => {
    const { publicKey, privateKey } = await generateKeyPair('ES256');
    const jwks = createLocalJWKSet({ keys: [{ ...(await exportJWK(publicKey)), alg: 'ES256', kid: 'k' }] });
    sign = (sub, over = {}) =>
      new SignJWT({}).setProtectedHeader({ alg: 'ES256', kid: 'k' }).setIssuer('https://idp/').setAudience(over.aud ?? 'api').setSubject(sub).setExpirationTime('5m').sign(privateKey);

    const moduleRef = await Test.createTestingModule({ imports: [AppModule.register({ ...testConfig, auth: { mode: 'jwt', issuer: 'https://idp/', audience: 'api', jwksUrl: 'https://idp/jwks' } })] })
      .overrideProvider(FILES).useValue(new MemoryFileStore())
      .overrideProvider(S3).useValue(new FakeS3())
      .overrideProvider(S3_PRESIGNER).useValue(offlinePresigner())
      .overrideProvider(AUTHENTICATOR).useValue(new JwtAuthenticator(jwks, { issuer: 'https://idp/', audience: 'api' }))
      .compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });
  afterEach(() => app.close());

  const body = { fileName: 'clip.mp4', fileSize: 12 * MiB, contentType: 'video/mp4' };

  it('keeps /health public and protects everything else', async () => {
    const http = request(app.getHttpServer());
    await http.get('/health').expect(200);
    await http.get('/files').expect(401);
    await http.post('/uploads').send(body).expect(401);
    await http.get('/files/stream').expect(401);
  });

  it('ignores a spoofed x-user-id when JWT auth is on', async () => {
    await request(app.getHttpServer()).get('/files').set('x-user-id', 'alice').expect(401);
  });

  it('rejects tokens for the wrong audience', async () => {
    await request(app.getHttpServer()).get('/files').set('authorization', `Bearer ${await sign('alice', { aud: 'other' })}`).expect(401);
  });

  it('serves the owner and isolates users, with identities taken from the token alone', async () => {
    const http = request(app.getHttpServer());
    const alice = `Bearer ${await sign('alice')}`;
    const mallory = `Bearer ${await sign('mallory')}`;
    const created = await http.post('/uploads').set('authorization', alice).send(body).expect(201);
    const id = created.body.file.id as string;

    await http.get(`/files/${id}`).set('authorization', alice).expect(200);
    await http.get(`/files/${id}`).set('authorization', mallory).expect(404);
    await http.post(`/uploads/${id}/parts/1/presign`).set('authorization', mallory).send({ sha256: Buffer.alloc(32, 1).toString('base64') }).expect(404);
    expect((await http.get('/files').set('authorization', mallory).expect(200)).body.files).toEqual([]);
    expect((await http.get('/files').set('authorization', alice).expect(200)).body.files).toHaveLength(1);
  });
});
