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

describe('limits configuration', () => {
  it('has sensible defaults', () => {
    const c = loadConfig({ ...base });
    expect(c.quotas).toEqual({ maxActiveUploads: 10, maxStoredBytes: 100 * 1024 ** 3 });
    expect(c.rateLimits).toEqual({ ipPerMinute: 1200, callerPerMinute: 1500, initPerMinute: 30 });
    expect(c.trustProxyHops).toBe(0);
  });

  it('reads overrides, and 0 turns a quota off', () => {
    const c = loadConfig({
      ...base, MAX_ACTIVE_UPLOADS_PER_USER: '0', MAX_STORED_BYTES_PER_USER: '5000', RATE_LIMIT_IP_PER_MINUTE: '50',
      RATE_LIMIT_USER_PER_MINUTE: '60', RATE_LIMIT_INIT_PER_MINUTE: '3', TRUST_PROXY_HOPS: '1',
    });
    expect(c.quotas).toEqual({ maxActiveUploads: 0, maxStoredBytes: 5000 });
    expect(c.rateLimits).toEqual({ ipPerMinute: 50, callerPerMinute: 60, initPerMinute: 3 });
    expect(c.trustProxyHops).toBe(1);
  });

  it.each([
    ['MAX_ACTIVE_UPLOADS_PER_USER', '-1'],
    ['MAX_ACTIVE_UPLOADS_PER_USER', '1.5'],
    ['MAX_STORED_BYTES_PER_USER', 'lots'],
    ['RATE_LIMIT_IP_PER_MINUTE', '0'],
    ['RATE_LIMIT_USER_PER_MINUTE', '0'],
    ['RATE_LIMIT_INIT_PER_MINUTE', '-5'],
    ['TRUST_PROXY_HOPS', '-1'],
    ['TRUST_PROXY_HOPS', '1.5'],
  ])('rejects %s=%s instead of silently misbehaving', (name, value) => {
    expect(() => loadConfig({ ...base, [name]: value })).toThrow(new RegExp(name));
  });
});

describe('log level', () => {
  it('defaults to info and accepts the known levels', () => {
    expect(loadConfig({ ...base }).logLevel).toBe('info');
    for (const level of ['debug', 'info', 'warn', 'error', 'silent']) expect(loadConfig({ ...base, LOG_LEVEL: level }).logLevel).toBe(level);
  });

  it('rejects anything else instead of silently logging nothing (or everything)', () => {
    expect(() => loadConfig({ ...base, LOG_LEVEL: 'verbose' })).toThrow(/LOG_LEVEL/);
  });
});
