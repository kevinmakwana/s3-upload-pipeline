import { DEFAULT_ALLOWED_TYPES, DEFAULT_MAX_FILE_SIZE, DEFAULT_PART_SIZE, type ValidationRules } from '@s3up/core';

export interface AppConfig {
  port: number;
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
