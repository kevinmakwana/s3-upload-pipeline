import { DEFAULT_ALLOWED_TYPES, DEFAULT_MAX_FILE_SIZE, DEFAULT_PART_SIZE, type ValidationRules } from '@s3up/core';

export type AuthConfig = { mode: 'header' } | { mode: 'jwt'; issuer: string; audience: string; jwksUrl: string };

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
  /** How long an unfinished upload record lingers before DynamoDB TTL removes it. */
  pendingTtlSeconds: number;
  ssePollMs: number;
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
    pendingTtlSeconds: int(env.PENDING_TTL_SECONDS, 3 * 24 * 3600),
    ssePollMs: int(env.SSE_POLL_MS, 1000),
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
