import { createHash } from 'node:crypto';
import { HttpError } from '@s3up/core';
import { OidcSession, type OidcConfig } from './oidc';

const config: OidcConfig = {
  authorizeUrl: 'https://login.example.com/oauth2/authorize',
  tokenUrl: 'https://login.example.com/oauth2/token',
  logoutUrl: 'https://login.example.com/logout',
  clientId: 'client-1',
  scope: 'openid email',
};
const ORIGIN = 'https://app.example.com';

const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
/** An unsigned JWT: the page only reads `exp`; the API is what verifies signatures. */
const jwt = (exp: number) => `${b64({ alg: 'none' })}.${b64({ exp })}.sig`;

class MemoryStorage {
  readonly data = new Map<string, string>();
  getItem = (k: string) => this.data.get(k) ?? null;
  setItem = (k: string, v: string) => void this.data.set(k, v);
  removeItem = (k: string) => void this.data.delete(k);
}

interface Rig {
  session: OidcSession;
  storage: MemoryStorage;
  assigned: string[];
  replaced: string[];
  tokenRequests: URLSearchParams[];
  clock: { now: number };
}

function rig(opts: { search?: string; respond?: (body: URLSearchParams) => Response | Promise<Response>; now?: number } = {}): Rig {
  const storage = new MemoryStorage();
  const assigned: string[] = [];
  const replaced: string[] = [];
  const tokenRequests: URLSearchParams[] = [];
  const clock = { now: opts.now ?? 1_000_000_000_000 };
  const session = new OidcSession({
    config,
    page: { origin: ORIGIN, pathname: '/', search: opts.search ?? '', assign: (u) => assigned.push(u), replaceUrl: (u) => replaced.push(u) },
    storage,
    fetch: async (url, init) => {
      expect(String(url)).toBe(config.tokenUrl);
      expect(init?.method).toBe('POST');
      expect((init?.headers as Record<string, string>)['content-type']).toBe('application/x-www-form-urlencoded');
      const body = new URLSearchParams(String(init?.body));
      tokenRequests.push(body);
      return opts.respond ? opts.respond(body) : new Response('{}', { status: 400 });
    },
    now: () => clock.now,
  });
  return { session, storage, assigned, replaced, tokenRequests, clock };
}

const tokens = (idExpSeconds: number, extra: object = {}) =>
  new Response(JSON.stringify({ id_token: jwt(idExpSeconds), access_token: 'a', refresh_token: 'r1', expires_in: 3600, token_type: 'Bearer', ...extra }), { status: 200 });

describe('OidcSession', () => {
  describe('signing in', () => {
    it('sends a signed-out visitor to the login page with a PKCE challenge and a state', async () => {
      const { session, assigned, storage } = rig();
      expect(await session.start()).toBe('redirecting');
      const url = new URL(assigned[0]!);
      expect(`${url.origin}${url.pathname}`).toBe(config.authorizeUrl);
      expect(url.searchParams.get('response_type')).toBe('code');
      expect(url.searchParams.get('client_id')).toBe('client-1');
      expect(url.searchParams.get('redirect_uri')).toBe(`${ORIGIN}/`);
      expect(url.searchParams.get('scope')).toBe('openid email');
      expect(url.searchParams.get('code_challenge_method')).toBe('S256');

      // The challenge is the SHA-256 of a verifier that stays in this tab, and the state is stored to be checked on return.
      const verifier = storage.getItem('s3up:oidc:verifier')!;
      expect(verifier.length).toBeGreaterThanOrEqual(43);
      expect(url.searchParams.get('code_challenge')).toBe(createHash('sha256').update(verifier).digest('base64url'));
      expect(url.searchParams.get('state')).toBe(storage.getItem('s3up:oidc:state'));
      expect(url.searchParams.get('state')!.length).toBeGreaterThanOrEqual(16);
    });

    it('uses a different verifier and state every time', async () => {
      const a = rig();
      const b = rig();
      await a.session.start();
      await b.session.start();
      expect(a.storage.getItem('s3up:oidc:verifier')).not.toBe(b.storage.getItem('s3up:oidc:verifier'));
      expect(a.storage.getItem('s3up:oidc:state')).not.toBe(b.storage.getItem('s3up:oidc:state'));
    });

    it('exchanges the code on return, then cleans the address bar and the temporary values', async () => {
      const first = rig();
      await first.session.start();
      const state = first.storage.getItem('s3up:oidc:state')!;
      const verifier = first.storage.getItem('s3up:oidc:verifier')!;

      const exp = Math.floor(first.clock.now / 1000) + 3600;
      const back = rig({ search: `?code=abc&state=${state}`, respond: () => tokens(exp) });
      for (const [k, v] of first.storage.data) back.storage.setItem(k, v);

      expect(await back.session.start()).toBe('signed-in');
      expect(Object.fromEntries(back.tokenRequests[0]!)).toEqual({
        grant_type: 'authorization_code',
        client_id: 'client-1',
        code: 'abc',
        redirect_uri: `${ORIGIN}/`,
        code_verifier: verifier,
      });
      expect(back.replaced).toEqual([`${ORIGIN}/`]);
      expect(back.storage.getItem('s3up:oidc:verifier')).toBeNull();
      expect(back.storage.getItem('s3up:oidc:state')).toBeNull();
      expect(back.assigned).toEqual([]);
      expect(await back.session.getIdToken()).toBe(jwt(exp));
    });

    it('refuses a return whose state does not match (a forged or stale callback) and does not call the token endpoint', async () => {
      const r = rig({ search: '?code=abc&state=forged' });
      r.storage.setItem('s3up:oidc:state', 'the-real-state');
      r.storage.setItem('s3up:oidc:verifier', 'v'.repeat(64));
      await expect(r.session.start()).rejects.toThrow(/state/i);
      expect(r.tokenRequests).toHaveLength(0);
      expect(r.storage.getItem('s3up:oidc:state')).toBeNull(); // single use
    });

    it('refuses a return when this tab never started a sign-in', async () => {
      const r = rig({ search: '?code=abc&state=anything' });
      await expect(r.session.start()).rejects.toThrow(/state/i);
      expect(r.tokenRequests).toHaveLength(0);
    });

    it('shows the login error instead of looping back to the login page', async () => {
      const r = rig({ search: '?error=access_denied&error_description=User+is+disabled' });
      await expect(r.session.start()).rejects.toThrow(/User is disabled/);
      expect(r.assigned).toEqual([]);
    });

    it('fails with the server message when the code exchange is rejected', async () => {
      const first = rig();
      await first.session.start();
      const r = rig({ search: `?code=abc&state=${first.storage.getItem('s3up:oidc:state')}`, respond: () => new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 }) });
      for (const [k, v] of first.storage.data) r.storage.setItem(k, v);
      await expect(r.session.start()).rejects.toThrow(/invalid_grant/);
    });

    it('keeps an existing sign-in across reloads instead of going back to the login page', async () => {
      const r = rig();
      const exp = Math.floor(r.clock.now / 1000) + 3600;
      r.storage.setItem('s3up:oidc:tokens', JSON.stringify({ idToken: jwt(exp), refreshToken: 'r1' }));
      expect(await r.session.start()).toBe('signed-in');
      expect(r.assigned).toEqual([]);
      expect(r.tokenRequests).toHaveLength(0);
    });
  });

  describe('the token the API receives', () => {
    const signedIn = (clock = 1_000_000_000_000, respond?: (body: URLSearchParams) => Response | Promise<Response>) => {
      const r = rig({ now: clock, respond });
      r.storage.setItem('s3up:oidc:tokens', JSON.stringify({ idToken: jwt(Math.floor(clock / 1000) + 3600), refreshToken: 'r1' }));
      return r;
    };

    it('is the ID token (its audience is the client id, which is what the API checks)', async () => {
      const r = signedIn();
      await r.session.start();
      expect(await r.session.getIdToken()).toBe(jwt(Math.floor(r.clock.now / 1000) + 3600));
    });

    it('is refreshed shortly before it expires, keeping the refresh token Cognito does not rotate', async () => {
      const r = signedIn(undefined, () => tokens(Math.floor(r.clock.now / 1000) + 7200, { refresh_token: undefined }));
      await r.session.start();
      r.clock.now += 3600_000 - 30_000; // 30 seconds left: inside the safety margin
      const fresh = await r.session.getIdToken();
      expect(fresh).toBe(jwt(Math.floor(r.clock.now / 1000) + 7200));
      expect(Object.fromEntries(r.tokenRequests[0]!)).toEqual({ grant_type: 'refresh_token', client_id: 'client-1', refresh_token: 'r1' });
      // A later refresh still has the original refresh token.
      r.clock.now += 7200_000 - 10_000;
      await r.session.getIdToken();
      expect(r.tokenRequests[1]!.get('refresh_token')).toBe('r1');
    });

    it('is refreshed once when many requests ask at the same moment', async () => {
      const r = signedIn(undefined, () => tokens(Math.floor(r.clock.now / 1000) + 7200));
      await r.session.start();
      r.clock.now += 3600_000;
      const all = await Promise.all([r.session.getIdToken(), r.session.getIdToken(), r.session.getIdToken()]);
      expect(new Set(all).size).toBe(1);
      expect(r.tokenRequests).toHaveLength(1);
    });

    it('sends the user back to the login page, with a non-retryable 401, when the refresh token is no longer good', async () => {
      const r = signedIn(undefined, () => new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 }));
      await r.session.start();
      r.clock.now += 3600_000;
      const err = await r.session.getIdToken().catch((e) => e);
      expect(err).toBeInstanceOf(HttpError);
      expect(err).toMatchObject({ status: 401, retryable: false });
      expect(r.assigned).toHaveLength(1);
      expect(r.storage.getItem('s3up:oidc:tokens')).toBeNull();
    });

    it('keeps the session when the refresh fails only because the network is down', async () => {
      const r = signedIn(undefined, () => Promise.reject(new TypeError('offline')));
      await r.session.start();
      r.clock.now += 3600_000;
      const err = await r.session.getIdToken().catch((e) => e);
      expect(err).toBeInstanceOf(HttpError);
      expect(err).toMatchObject({ retryable: true });
      expect(r.assigned).toEqual([]);
      expect(r.storage.getItem('s3up:oidc:tokens')).not.toBeNull();
    });

    it('treats a token it cannot read as expired rather than sending it', async () => {
      const r = rig({ respond: () => tokens(Math.floor(1_000_000_000_000 / 1000) + 3600) });
      r.storage.setItem('s3up:oidc:tokens', JSON.stringify({ idToken: 'garbage', refreshToken: 'r1' }));
      await r.session.start();
      expect(await r.session.getIdToken()).toBe(jwt(Math.floor(r.clock.now / 1000) + 3600));
      expect(r.tokenRequests).toHaveLength(1);
    });
  });

  describe('signing out', () => {
    it('forgets the tokens and ends the login session too, returning to the app', async () => {
      const r = rig();
      r.storage.setItem('s3up:oidc:tokens', JSON.stringify({ idToken: jwt(2_000_000_000), refreshToken: 'r1' }));
      r.session.signOut();
      expect(r.storage.getItem('s3up:oidc:tokens')).toBeNull();
      const url = new URL(r.assigned[0]!);
      expect(`${url.origin}${url.pathname}`).toBe(config.logoutUrl);
      expect(url.searchParams.get('client_id')).toBe('client-1');
      expect(url.searchParams.get('logout_uri')).toBe(`${ORIGIN}/`);
    });
  });
});
