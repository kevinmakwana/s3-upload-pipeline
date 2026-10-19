import { loadRuntimeConfig } from './config';

const json = (body: unknown, init: ResponseInit = {}) =>
  new Response(typeof body === 'string' ? body : JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' }, ...init });

const oidc = {
  mode: 'oidc',
  authorizeUrl: 'https://login.example.com/oauth2/authorize',
  tokenUrl: 'https://login.example.com/oauth2/token',
  logoutUrl: 'https://login.example.com/logout',
  clientId: 'client-1',
  scope: 'openid email',
};

describe('loadRuntimeConfig', () => {
  it('reads /config.json without letting the browser cache it', async () => {
    const seen: { url: string; init: RequestInit | undefined }[] = [];
    const config = await loadRuntimeConfig(async (url, init) => {
      seen.push({ url: String(url), init });
      return json({ apiUrl: 'https://api.example.com/', auth: oidc });
    });
    expect(seen).toEqual([{ url: '/config.json', init: expect.objectContaining({ cache: 'no-store' }) }]);
    expect(config).toEqual({ apiUrl: 'https://api.example.com', auth: oidc });
  });

  it('accepts the demo mode and an api-only config', async () => {
    expect(await loadRuntimeConfig(async () => json({ apiUrl: 'https://api.example.com', auth: { mode: 'demo' } }))).toEqual({
      apiUrl: 'https://api.example.com',
      auth: { mode: 'demo' },
    });
    expect(await loadRuntimeConfig(async () => json({ apiUrl: 'http://localhost:3001' }))).toEqual({ apiUrl: 'http://localhost:3001' });
  });

  it.each([
    ['there is no file (404)', async () => new Response('nope', { status: 404 })],
    ['a dev server answers with the HTML shell', async () => new Response('<!doctype html>', { status: 200, headers: { 'content-type': 'text/html' } })],
    ['the network fails', async () => Promise.reject(new TypeError('offline'))],
  ])('falls back to the build-time settings when %s', async (_name, fetchFn) => {
    expect(await loadRuntimeConfig(fetchFn)).toEqual({});
  });

  it.each([
    ['an api url that is not http(s)', { apiUrl: 'javascript:alert(1)' }],
    ['an api url that is not a string', { apiUrl: 5 }],
    ['an unknown auth mode', { auth: { mode: 'magic' } }],
    ['an oidc config without a client id', { auth: { ...oidc, clientId: '' } }],
    ['a login address that is plain http on the open internet', { auth: { ...oidc, authorizeUrl: 'http://login.example.com/oauth2/authorize' } }],
    ['a token address that is not a url', { auth: { ...oidc, tokenUrl: 'not a url' } }],
    ['something that is not an object', []],
  ])('refuses %s, because a wrong config should fail loudly rather than point the page somewhere unintended', async (_name, body) => {
    await expect(loadRuntimeConfig(async () => json(body))).rejects.toThrow(/config\.json/);
  });

  it('allows a plain-http login address on localhost, for development', async () => {
    const auth = { ...oidc, authorizeUrl: 'http://localhost:9000/authorize', tokenUrl: 'http://localhost:9000/token', logoutUrl: 'http://localhost:9000/logout' };
    expect(await loadRuntimeConfig(async () => json({ auth }))).toEqual({ auth });
  });
});
