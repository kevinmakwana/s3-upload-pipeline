import { HttpError } from '@s3up/core';

export interface OidcConfig {
  authorizeUrl: string;
  tokenUrl: string;
  logoutUrl: string;
  clientId: string;
  scope: string;
}

/** The slice of the browser the session needs, so tests can supply their own. */
export interface OidcDeps {
  config: OidcConfig;
  page: {
    origin: string;
    pathname: string;
    search: string;
    /** Navigate away (to the login page). */
    assign(url: string): void;
    /** Change the address bar without reloading. */
    replaceUrl(url: string): void;
  };
  /** Per-tab storage: tokens vanish when the tab does. */
  storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  now?: () => number;
}

const K_TOKENS = 's3up:oidc:tokens';
const K_STATE = 's3up:oidc:state';
const K_VERIFIER = 's3up:oidc:verifier';
/** A token with less than this left is replaced before use, so it cannot lapse mid-request. */
const MARGIN_MS = 60_000;

interface Tokens {
  idToken: string;
  refreshToken?: string;
}

/**
 * Sign-in with the OAuth 2.0 authorization code flow and PKCE against an OpenID provider (Cognito's
 * hosted login). The API receives the ID token: its audience is this client, which is what the API checks.
 * Tokens live in sessionStorage, so they are gone when the tab closes, but any script on the page can read
 * them; the page's Content-Security-Policy is what keeps scripts out.
 */
export class OidcSession {
  private refreshing: Promise<string> | undefined;

  constructor(private readonly deps: OidcDeps) {}

  /**
   * Call before the app starts. Completes a sign-in if the page was just redirected back with a code;
   * otherwise keeps a stored session, or sends the visitor to the login page ('redirecting': stop there).
   */
  async start(): Promise<'signed-in' | 'redirecting'> {
    const params = new URLSearchParams(this.deps.page.search);
    const error = params.get('error');
    if (error) {
      this.clearTransient();
      throw new Error(params.get('error_description') || error);
    }
    const code = params.get('code');
    if (code) {
      await this.finishLogin(code, params.get('state'));
      return 'signed-in';
    }
    const stored = this.readTokens();
    if (stored && (stored.refreshToken || expiresAt(stored.idToken) > this.now() + MARGIN_MS)) return 'signed-in';
    await this.beginLogin();
    return 'redirecting';
  }

  /** A valid ID token, refreshed if it is about to expire. Many callers at once share one refresh. */
  async getIdToken(): Promise<string> {
    const tokens = this.readTokens();
    if (!tokens) {
      await this.beginLogin();
      throw notSignedIn();
    }
    if (expiresAt(tokens.idToken) > this.now() + MARGIN_MS) return tokens.idToken;
    this.refreshing ??= this.refresh(tokens).finally(() => {
      this.refreshing = undefined;
    });
    return this.refreshing;
  }

  /** Forget the tokens and end the login page's own session as well, then come back to the app. */
  signOut(): void {
    this.deps.storage.removeItem(K_TOKENS);
    this.clearTransient();
    const url = new URL(this.deps.config.logoutUrl);
    url.searchParams.set('client_id', this.deps.config.clientId);
    url.searchParams.set('logout_uri', this.redirectUri());
    this.deps.page.assign(url.toString());
  }

  private async beginLogin(): Promise<void> {
    const verifier = randomString(48);
    const state = randomString(24);
    this.deps.storage.setItem(K_VERIFIER, verifier);
    this.deps.storage.setItem(K_STATE, state);
    const url = new URL(this.deps.config.authorizeUrl);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', this.deps.config.clientId);
    url.searchParams.set('redirect_uri', this.redirectUri());
    url.searchParams.set('scope', this.deps.config.scope);
    url.searchParams.set('state', state);
    url.searchParams.set('code_challenge', await challengeFor(verifier));
    url.searchParams.set('code_challenge_method', 'S256');
    this.deps.page.assign(url.toString());
  }

  private async finishLogin(code: string, state: string | null): Promise<void> {
    const expected = this.deps.storage.getItem(K_STATE);
    const verifier = this.deps.storage.getItem(K_VERIFIER);
    this.clearTransient(); // single use, whatever happens next
    if (!expected || !verifier || state !== expected) {
      throw new Error('Sign-in failed: the state did not match (the link is stale or was not started in this tab). Reload to try again.');
    }
    const body = await this.tokenRequest({
      grant_type: 'authorization_code',
      client_id: this.deps.config.clientId,
      code,
      redirect_uri: this.redirectUri(),
      code_verifier: verifier,
    });
    this.writeTokens({ idToken: body.id_token, refreshToken: body.refresh_token });
    this.deps.page.replaceUrl(`${this.deps.page.origin}${this.deps.page.pathname}`);
  }

  private async refresh(tokens: Tokens): Promise<string> {
    if (!tokens.refreshToken) return this.expire();
    let body: TokenResponse;
    try {
      body = await this.tokenRequest({ grant_type: 'refresh_token', client_id: this.deps.config.clientId, refresh_token: tokens.refreshToken });
    } catch (err) {
      if (err instanceof RejectedGrant) return this.expire();
      throw new HttpError(`Could not refresh the sign-in: ${(err as Error).message}`, undefined, true);
    }
    // Cognito does not rotate refresh tokens: keep the one we have unless a new one is sent.
    this.writeTokens({ idToken: body.id_token, refreshToken: body.refresh_token ?? tokens.refreshToken });
    return body.id_token;
  }

  /** The session is over: forget it and go to the login page. */
  private async expire(): Promise<never> {
    this.deps.storage.removeItem(K_TOKENS);
    await this.beginLogin();
    throw notSignedIn();
  }

  private async tokenRequest(form: Record<string, string>): Promise<TokenResponse> {
    const res = await this.deps.fetch(this.deps.config.tokenUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(form).toString(),
    });
    const text = await res.text();
    let json: Partial<TokenResponse> & { error?: string; error_description?: string } = {};
    try {
      json = JSON.parse(text);
    } catch {
      /* not JSON: handled below */
    }
    if (res.status >= 400 && res.status < 500) throw new RejectedGrant(json.error_description ?? json.error ?? `HTTP ${res.status}`);
    if (!res.ok || !json.id_token) throw new Error(`The login service answered ${res.status}`);
    return json as TokenResponse;
  }

  private readTokens(): Tokens | undefined {
    try {
      const raw = this.deps.storage.getItem(K_TOKENS);
      const parsed = raw ? (JSON.parse(raw) as Partial<Tokens>) : undefined;
      return parsed && typeof parsed.idToken === 'string' ? { idToken: parsed.idToken, refreshToken: parsed.refreshToken } : undefined;
    } catch {
      return undefined;
    }
  }

  private writeTokens(tokens: Tokens): void {
    this.deps.storage.setItem(K_TOKENS, JSON.stringify(tokens));
  }

  private clearTransient(): void {
    this.deps.storage.removeItem(K_STATE);
    this.deps.storage.removeItem(K_VERIFIER);
  }

  /** Must equal one of the client's registered callback URLs exactly. */
  private redirectUri(): string {
    return `${this.deps.page.origin}/`;
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }
}

interface TokenResponse {
  id_token: string;
  refresh_token?: string;
}

/** The login service refused the code or refresh token (as opposed to being unreachable). */
class RejectedGrant extends Error {}

const notSignedIn = () => new HttpError('Not signed in: redirecting to the login page', 401, false);

/** `exp` of a JWT in milliseconds; 0 (already expired) when it cannot be read. */
function expiresAt(jwt: string): number {
  try {
    const payload = jwt.split('.')[1];
    if (!payload) return 0;
    const json = JSON.parse(new TextDecoder().decode(fromBase64Url(payload))) as { exp?: unknown };
    return typeof json.exp === 'number' ? json.exp * 1000 : 0;
  } catch {
    return 0;
  }
}

function randomString(bytes: number): string {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(bytes)));
}

async function challengeFor(verifier: string): Promise<string> {
  return toBase64Url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(text: string): Uint8Array {
  const padded = text.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(text.length / 4) * 4, '=');
  return Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
}
