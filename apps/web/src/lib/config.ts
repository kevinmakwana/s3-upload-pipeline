import type { OidcConfig } from './oidc';

/**
 * Settings that belong to a deployment, not to a build: where the API is and how to sign in.
 * A hosted deployment publishes them as /config.json; without one, the build-time VITE_* values apply.
 */
export interface RuntimeConfig {
  apiUrl?: string;
  auth?: { mode: 'demo' } | ({ mode: 'oidc' } & OidcConfig);
}

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

/**
 * Reads /config.json. A missing file, a non-JSON answer (a dev server returns its HTML shell for
 * unknown paths) or a network error means "no runtime config". A file that is there but wrong
 * throws, because quietly pointing the page somewhere unintended is worse than not loading.
 */
export async function loadRuntimeConfig(fetchFn: Fetch = (url, init) => fetch(url, init)): Promise<RuntimeConfig> {
  let body: unknown;
  try {
    const res = await fetchFn('/config.json', { cache: 'no-store', headers: { accept: 'application/json' } });
    if (!res.ok) return {};
    body = JSON.parse(await res.text());
  } catch {
    return {};
  }
  return parse(body);
}

function parse(body: unknown): RuntimeConfig {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw invalid('it must be a JSON object');
  const { apiUrl, auth } = body as Record<string, unknown>;
  const out: RuntimeConfig = {};
  if (apiUrl !== undefined) {
    if (typeof apiUrl !== 'string' || !/^https?:\/\//i.test(apiUrl)) throw invalid('apiUrl must be an http(s) URL');
    out.apiUrl = apiUrl.replace(/\/$/, '');
  }
  if (auth !== undefined) out.auth = parseAuth(auth);
  return out;
}

function parseAuth(auth: unknown): NonNullable<RuntimeConfig['auth']> {
  const a = (auth && typeof auth === 'object' ? auth : {}) as Record<string, unknown>;
  if (a.mode === 'demo') return { mode: 'demo' };
  if (a.mode !== 'oidc') throw invalid('auth.mode must be "demo" or "oidc"');
  const text = (name: string): string => {
    const v = a[name];
    if (typeof v !== 'string' || !v) throw invalid(`auth.${name} is required`);
    return v;
  };
  const url = (name: string): string => {
    const v = text(name);
    let parsed: URL;
    try {
      parsed = new URL(v);
    } catch {
      throw invalid(`auth.${name} is not a URL`);
    }
    const local = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1';
    if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && local)) throw invalid(`auth.${name} must be https`);
    return v;
  };
  return { mode: 'oidc', authorizeUrl: url('authorizeUrl'), tokenUrl: url('tokenUrl'), logoutUrl: url('logoutUrl'), clientId: text('clientId'), scope: text('scope') };
}

const invalid = (why: string) => new Error(`Invalid /config.json: ${why}`);
