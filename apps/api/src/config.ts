import { DEFAULT_ALLOWED_TYPES, DEFAULT_MAX_FILE_SIZE, DEFAULT_PART_SIZE, type ValidationRules } from '@s3up/core';

export type AuthConfig = { mode: 'header' } | { mode: 'jwt'; issuer: string; audience: string; jwksUrl: string };

/** Per-user limits on what an account may hold. 0 turns a limit off. */
export interface Quotas {
  /** Uploads a user may have in progress at once. */
  maxActiveUploads: number;
  /** Bytes a user may hold: uploads in progress (their declared size) plus every finished file. */
  maxStoredBytes: number;
}

/** Requests per minute. */
export interface RateLimits {
  /** Per client address, counted before authentication (stops floods of bogus credentials). */
  ipPerMinute: number;
  /** Per credential (bearer token or demo user id). Presigning one URL per part is the bulk of this. */
  callerPerMinute: number;
  /** Per credential, for starting uploads only. */
  initPerMinute: number;
}

export interface AppConfig {
  port: number;
  auth: AuthConfig;
  bucket: string;
  table: string;
  /** Endpoint the *browser* must use to reach S3 (differs from the API's own when containerised). */
  s3PublicEndpoint?: string;
  corsOrigins: string[];
  rules: ValidationRules;
  preferredPartSize: number;
  presignExpiresSeconds: number;
  thumbnailUrlExpiresSeconds: number;
  /** How long a download link stays valid. */
  downloadUrlExpiresSeconds: number;
  /** How long an unfinished upload record lingers before DynamoDB TTL removes it. */
  pendingTtlSeconds: number;
  ssePollMs: number;
  quotas: Quotas;
  rateLimits: RateLimits;
  /** Proxies in front of the API whose X-Forwarded-For to trust (0 when clients connect directly). */
  trustProxyHops: number;
}

const int = (v: string | undefined, fallback: number) => {
  const n = v === undefined || v === '' ? fallback : Number(v);
  if (!Number.isFinite(n)) throw new Error(`Expected a number, got "${v}"`);
  return n;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const required = (name: string) => {
    const v = env[name];
    if (!v) throw new Error(`Missing required environment variable ${name}`);
    return v;
  };
  /** A whole number of at least `min`, from the environment or the fallback. */
  const whole = (name: string, fallback: number, min: number) => {
    const raw = env[name];
    const n = raw === undefined || raw === '' ? fallback : Number(raw);
    if (!Number.isInteger(n) || n < min) throw new Error(`${name} must be a whole number of at least ${min}, got "${raw}"`);
    return n;
  };
  return {
    port: int(env.PORT, 3001),
    auth: loadAuth(env, required),
    bucket: required('BUCKET_NAME'),
    table: required('TABLE_NAME'),
    s3PublicEndpoint: env.S3_PUBLIC_ENDPOINT || undefined,
    corsOrigins: (env.CORS_ORIGINS ?? 'http://localhost:5173').split(',').map((s) => s.trim()).filter(Boolean),
    rules: { maxFileSize: int(env.MAX_FILE_SIZE_BYTES, DEFAULT_MAX_FILE_SIZE), allowedTypes: DEFAULT_ALLOWED_TYPES },
    preferredPartSize: int(env.PART_SIZE_BYTES, DEFAULT_PART_SIZE),
    // Short-lived by design; clamped so a typo can't mint week-long URLs.
    presignExpiresSeconds: Math.min(3600, Math.max(60, int(env.PRESIGN_EXPIRES_SECONDS, 900))),
    thumbnailUrlExpiresSeconds: 300,
    downloadUrlExpiresSeconds: Math.min(3600, Math.max(60, int(env.DOWNLOAD_URL_EXPIRES_SECONDS, 300))),
    pendingTtlSeconds: int(env.PENDING_TTL_SECONDS, 3 * 24 * 3600),
    ssePollMs: int(env.SSE_POLL_MS, 1000),
    quotas: {
      maxActiveUploads: whole('MAX_ACTIVE_UPLOADS_PER_USER', 10, 0),
      maxStoredBytes: whole('MAX_STORED_BYTES_PER_USER', 100 * 1024 ** 3, 0),
    },
    rateLimits: {
      ipPerMinute: whole('RATE_LIMIT_IP_PER_MINUTE', 1200, 1),
      callerPerMinute: whole('RATE_LIMIT_USER_PER_MINUTE', 1500, 1),
      initPerMinute: whole('RATE_LIMIT_INIT_PER_MINUTE', 30, 1),
    },
    trustProxyHops: whole('TRUST_PROXY_HOPS', 0, 0),
  };
}

/**
 * AUTH_MODE=jwt verifies bearer tokens from your identity provider (set JWT_ISSUER, JWT_AUDIENCE,
 * JWT_JWKS_URL). The default, header, trusts x-user-id and exists only for the local demo, so it
 * fails closed when NODE_ENV=production unless explicitly allowed.
 */
function loadAuth(env: NodeJS.ProcessEnv, required: (name: string) => string): AuthConfig {
  const mode = env.AUTH_MODE ?? 'header';
  if (mode === 'jwt') {
    const jwksUrl = required('JWT_JWKS_URL');
    if (!/^https:\/\//.test(jwksUrl) && !/^http:\/\/(localhost|127\.0\.0\.1)/.test(jwksUrl)) {
      throw new Error('JWT_JWKS_URL must be an https URL');
    }
    return { mode: 'jwt', issuer: required('JWT_ISSUER'), audience: required('JWT_AUDIENCE'), jwksUrl };
  }
  if (mode !== 'header') throw new Error(`AUTH_MODE must be "jwt" or "header", got "${mode}"`);
  if (env.NODE_ENV === 'production' && env.ALLOW_INSECURE_DEMO_AUTH !== 'true') {
    throw new Error(
      'Refusing to start: AUTH_MODE=header trusts any x-user-id and is for demos only. ' +
        'Set AUTH_MODE=jwt (with JWT_ISSUER, JWT_AUDIENCE, JWT_JWKS_URL), or ALLOW_INSECURE_DEMO_AUTH=true to accept the risk.',
    );
  }
  return { mode: 'header' };
}
