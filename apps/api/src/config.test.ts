import { loadConfig } from './config';

const base = { BUCKET_NAME: 'b', TABLE_NAME: 't' };

describe('auth configuration', () => {
  it('defaults to demo header auth outside production', () => {
    expect(loadConfig({ ...base }).auth).toEqual({ mode: 'header' });
  });

  it('refuses to start with demo auth in production unless explicitly allowed', () => {
    expect(() => loadConfig({ ...base, NODE_ENV: 'production' })).toThrow(/Refusing to start/);
    expect(loadConfig({ ...base, NODE_ENV: 'production', ALLOW_INSECURE_DEMO_AUTH: 'true' }).auth).toEqual({ mode: 'header' });
  });

  it('requires issuer, audience and JWKS URL for jwt mode', () => {
    const jwt = { ...base, NODE_ENV: 'production', AUTH_MODE: 'jwt' };
    expect(() => loadConfig(jwt)).toThrow(/JWT_JWKS_URL/);
    expect(() => loadConfig({ ...jwt, JWT_JWKS_URL: 'https://idp/.well-known/jwks.json' })).toThrow(/JWT_ISSUER/);
    expect(loadConfig({ ...jwt, JWT_JWKS_URL: 'https://idp/jwks', JWT_ISSUER: 'https://idp/', JWT_AUDIENCE: 'api' }).auth).toEqual({
      mode: 'jwt', issuer: 'https://idp/', audience: 'api', jwksUrl: 'https://idp/jwks',
    });
  });

  it('only fetches signing keys over https (or from localhost for development)', () => {
    const env = { ...base, AUTH_MODE: 'jwt', JWT_ISSUER: 'i', JWT_AUDIENCE: 'a' };
    expect(() => loadConfig({ ...env, JWT_JWKS_URL: 'http://idp.example.com/jwks' })).toThrow(/https/);
    expect(() => loadConfig({ ...env, JWT_JWKS_URL: 'http://localhost:9000/jwks' })).not.toThrow();
  });

  it('rejects unknown modes instead of silently falling back to demo auth', () => {
    expect(() => loadConfig({ ...base, AUTH_MODE: 'jtw' })).toThrow(/AUTH_MODE/);
  });
});
