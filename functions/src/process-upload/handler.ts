import type { S3Event, S3EventRecord, SQSBatchResponse, SQSEvent, SQSRecord } from 'aws-lambda';
import { createDocClient, createS3Client, DynamoFileStore, DynamoProcessingLedger } from '@s3up/data';
import { MiB } from '@s3up/core';
import { processObject, type ProcessorDeps } from './processor';
import { S3ObjectStorage } from './s3-storage';

const log = (message: string, fields: Record<string, unknown> = {}) => console.log(JSON.stringify({ message, ...fields }));

let cached: ProcessorDeps | undefined;

/** Built lazily so importing the module (e.g. in tests) needs no AWS configuration. */
function defaultDeps(): ProcessorDeps {
  if (cached) return cached;
  const table = requiredEnv('TABLE_NAME');
  const doc = createDocClient();
  cached = {
    files: new DynamoFileStore(doc, table),
    ledger: new DynamoProcessingLedger(doc, table),
    storage: new S3ObjectStorage(createS3Client(), requiredEnv('BUCKET_NAME')),
    config: {
      thumbnailMaxBytes: Number(process.env.THUMBNAIL_MAX_BYTES ?? 25 * MiB),
      leaseMs: Number(process.env.LEASE_MS ?? 16 * 60_000),
      maxReceiveCount: Number(process.env.MAX_RECEIVE_COUNT ?? 3),
    },
    log,
  };
  return cached;
}

function requiredEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing environment variable ${name}`);
  return v;
}

/** S3 event keys are URL-encoded, with spaces as "+". */
export function decodeKey(key: string): string {
  return decodeURIComponent(key.replace(/\+/g, ' '));
}

type Parsed = { kind: 'objects'; records: S3EventRecord[] } | { kind: 'ignore' };

function parseBody(body: string): Parsed {
  const event = JSON.parse(body) as Partial<S3Event> & { Event?: string };
  if (event.Event === 's3:TestEvent') return { kind: 'ignore' };
  if (!Array.isArray(event.Records)) throw new Error('Message is not an S3 event notification');
  return { kind: 'objects', records: event.Records.filter((r) => r.eventName.startsWith('ObjectCreated:')) };
}

/**
 * SQS-triggered worker. Uses partial batch responses: only messages that failed are
 * retried, and after the queue's maxReceiveCount they land in the DLQ (which alarms).
 */
export async function handleBatch(event: SQSEvent, deps: ProcessorDeps = defaultDeps()): Promise<SQSBatchResponse> {
  const batchItemFailures: SQSBatchResponse['batchItemFailures'] = [];
  for (const message of event.Records) {
    try {
      await handleMessage(message, deps);
    } catch (err) {
      (deps.log ?? log)('message failed', { messageId: message.messageId, error: err instanceof Error ? err.message : String(err) });
      batchItemFailures.push({ itemIdentifier: message.messageId });
    }
  }
  return { batchItemFailures };
}

async function handleMessage(message: SQSRecord, deps: ProcessorDeps): Promise<void> {
  const parsed = parseBody(message.body);
  if (parsed.kind === 'ignore') return;
  const receiveCount = Number(message.attributes?.ApproximateReceiveCount ?? 1);
  for (const record of parsed.records) {
    await processObject(
      deps,
      { key: decodeKey(record.s3.object.key), versionId: record.s3.object.versionId, etag: record.s3.object.eTag },
      receiveCount,
    );
  }
}

export const handler = (event: SQSEvent): Promise<SQSBatchResponse> => handleBatch(event);
