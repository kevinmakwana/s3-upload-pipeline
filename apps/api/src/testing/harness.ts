import { S3Client } from '@aws-sdk/client-s3';
import { MiB, DEFAULT_ALLOWED_TYPES } from '@s3up/core';
import { MemoryFileStore } from '@s3up/data';
import type { AppConfig } from '../config';
import { UploadsService } from '../uploads/uploads.service';
import { FakeS3 } from './fake-s3';

export const testConfig: AppConfig = {
  port: 0,
  auth: { mode: 'header' },
  bucket: 'test-bucket',
  table: 'test-table',
  s3PublicEndpoint: undefined,
  corsOrigins: ['http://localhost:5173'],
  rules: { maxFileSize: 1024 * MiB, allowedTypes: DEFAULT_ALLOWED_TYPES },
  preferredPartSize: 5 * MiB,
  presignExpiresSeconds: 900,
  thumbnailUrlExpiresSeconds: 300,
  downloadUrlExpiresSeconds: 300,
  quotas: { maxActiveUploads: 0, maxStoredBytes: 0 },
  // Out of the way of ordinary tests; the limit tests set their own.
  rateLimits: { ipPerMinute: 100_000, callerPerMinute: 100_000, initPerMinute: 100_000 },
  trustProxyHops: 0,
  pendingTtlSeconds: 3 * 24 * 3600,
  ssePollMs: 20,
};

/** A real S3 client with static credentials: signing is offline, so URLs can be inspected. */
export function offlinePresigner(): S3Client {
  return new S3Client({
    region: 'us-east-1',
    endpoint: 'http://localhost:4566',
    forcePathStyle: true,
    credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  });
}

export function makeService(overrides: Partial<AppConfig> = {}) {
  const s3 = new FakeS3();
  const files = new MemoryFileStore();
  const config = { ...testConfig, ...overrides };
  const service = new UploadsService(config, s3 as unknown as S3Client, offlinePresigner(), files);
  return { service, s3, files, config };
}
