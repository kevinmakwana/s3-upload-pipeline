import { createDocClient, createS3Client, DynamoFileStore, DynamoProcessingLedger } from '@s3up/data';
import { MiB } from '@s3up/core';
import type { ProcessorDeps } from './processor';
import { S3ObjectStorage } from './s3-storage';

export function requiredEnv(env: NodeJS.ProcessEnv, name: string): string {
  const v = env[name];
  if (!v) throw new Error(`Missing environment variable ${name}`);
  return v;
}

/** The real stores and clients, configured from the environment. Shared by the Lambda worker and the large-object job. */
export function processorDepsFromEnv(env: NodeJS.ProcessEnv, log: ProcessorDeps['log'], extra: Partial<ProcessorDeps> = {}): ProcessorDeps {
  const table = requiredEnv(env, 'TABLE_NAME');
  const doc = createDocClient();
  return {
    files: new DynamoFileStore(doc, table),
    ledger: new DynamoProcessingLedger(doc, table),
    storage: new S3ObjectStorage(createS3Client(), requiredEnv(env, 'BUCKET_NAME')),
    config: {
      thumbnailMaxBytes: Number(env.THUMBNAIL_MAX_BYTES ?? 25 * MiB),
      leaseMs: Number(env.LEASE_MS ?? 16 * 60_000),
      maxReceiveCount: Number(env.MAX_RECEIVE_COUNT ?? 3),
    },
    log,
    ...extra,
  };
}
