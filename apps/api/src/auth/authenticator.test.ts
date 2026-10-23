import { UnauthorizedException } from '@nestjs/common';
import { isValidUserId } from '@s3up/core';
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair, type CryptoKey, type JWK } from 'jose';
import { HeaderAuthenticator, JwtAuthenticator, userIdFor } from './authenticator';

const ISSUER = 'https://idp.example.com/';
const AUDIENCE = 'upload-api';

async function setup() {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const jwk: JWK = { ...(await exportJWK(publicKey)), alg: 'RS256', kid: 'k1', use: 'sig' };
  const auth = new JwtAuthenticator(createLocalJWKSet({ keys: [jwk] }), { issuer: ISSUER, audience: AUDIENCE });
  const token = (
    claims: Record<string, unknown> = {},
    opts: { exp?: number | string | null; iss?: string; aud?: string; key?: CryptoKey | Uint8Array; alg?: string } = {},
  ) => {
    let jwt = new SignJWT({ ...claims })
      .setProtectedHeader({ alg: opts.alg ?? 'RS256', kid: 'k1' })
      .setIssuedAt()
      .setIssuer(opts.iss ?? ISSUER)
      .setAudience(opts.aud ?? AUDIENCE);
    if (!('sub' in claims)) jwt = jwt.setSubject('user-123');
    if (opts.exp !== null) jwt = jwt.setExpirationTime(opts.exp ?? '5m');
    return jwt.sign(opts.key ?? privateKey);
  };
  const call = (t: string | undefined) => auth.authenticate({ authorization: t === undefined ? undefined : `Bearer ${t}` });
  return { auth, token, call, privateKey };
}

describe('JwtAuthenticator', () => {
  it('accepts a valid token and derives a stable, key-safe user id', async () => {
    const { token, call } = await setup();
    const id = await call(await token());
    expect(id).toBe(userIdFor(ISSUER, 'user-123'));
    expect(isValidUserId(id)).toBe(true);
    expect(await call(await token())).toBe(id);
  });

  it('keeps users and issuers apart, and makes any subject safe for an S3 prefix', async () => {
    const { token, call } = await setup();
    const a = await call(await token({ sub: 'auth0|abc/../def' }));
    const b = await call(await token({ sub: 'someone-else' }));
    expect(a).not.toBe(b);
    expect(isValidUserId(a)).toBe(true);
    expect(userIdFor('https://a/', 'x')).not.toBe(userIdFor('https://b/', 'x'));
  });

  it.each([
    ['expired', (t: Awaited<ReturnType<typeof setup>>) => t.token({}, { exp: Math.floor(Date.now() / 1000) - 3600 })],
    ['wrong issuer', (t: Awaited<ReturnType<typeof setup>>) => t.token({}, { iss: 'https://evil.example.com/' })],
    ['wrong audience', (t: Awaited<ReturnType<typeof setup>>) => t.token({}, { aud: 'some-other-api' })],
    ['no expiry', (t: Awaited<ReturnType<typeof setup>>) => t.token({}, { exp: null })],
    ['no subject', (t: Awaited<ReturnType<typeof setup>>) => t.token({ sub: undefined })],
  ])('rejects a token that is %s', async (_name, make) => {
    const ctx = await setup();
    await expect(ctx.call(await make(ctx))).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('rejects a token signed by a different key (forged)', async () => {
    const ctx = await setup();
    const other = await generateKeyPair('RS256');
    await expect(ctx.call(await ctx.token({}, { key: other.privateKey }))).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('rejects an HS256 token signed with the public key as the secret (algorithm confusion)', async () => {
    const { call } = await setup();
    const forged = await new SignJWT({})
      .setProtectedHeader({ alg: 'HS256', kid: 'k1' })
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setSubject('admin')
      .setExpirationTime('5m')
      .sign(new TextEncoder().encode('public-key-material'));
    await expect(call(forged)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('rejects unsigned tokens (alg none)', async () => {
    const { call } = await setup();
    const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const unsigned = `${b64({ alg: 'none', typ: 'JWT' })}.${b64({ iss: ISSUER, aud: AUDIENCE, sub: 'admin', exp: Math.floor(Date.now() / 1000) + 600 })}.x`;
    await expect(call(unsigned)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('rejects a tampered payload', async () => {
    const { call, token } = await setup();
    const [h, , s] = (await token()).split('.');
    const payload = Buffer.from(JSON.stringify({ iss: ISSUER, aud: AUDIENCE, sub: 'admin', exp: Math.floor(Date.now() / 1000) + 600 })).toString('base64url');
    await expect(call(`${h}.${payload}.${s}`)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it.each([undefined, '', 'Basic abc', 'Bearer', 'Bearer not-a-jwt', 'Bearer a.b'])(
    'rejects a missing or malformed Authorization header (%j)',
    async (header) => {
      const { auth } = await setup();
      await expect(auth.authenticate({ authorization: header })).rejects.toBeInstanceOf(UnauthorizedException);
    },
  );

  it('never reveals why a token was refused', async () => {
    const ctx = await setup();
    const expired = await ctx.call(await ctx.token({}, { exp: Math.floor(Date.now() / 1000) - 3600 })).catch((e) => e.message);
    const wrongAud = await ctx.call(await ctx.token({}, { aud: 'x' })).catch((e) => e.message);
    expect(expired).toBe(wrongAud);
  });
});

describe('HeaderAuthenticator (demo mode)', () => {
  it('accepts a well-formed x-user-id and nothing else', async () => {
    const a = new HeaderAuthenticator();
    expect(await a.authenticate({ 'x-user-id': 'alice' })).toBe('alice');
    for (const bad of [undefined, '', '../etc', 'a/b', 'x'.repeat(65)]) {
      await expect(a.authenticate({ 'x-user-id': bad })).rejects.toBeInstanceOf(UnauthorizedException);
    }
  });
});
