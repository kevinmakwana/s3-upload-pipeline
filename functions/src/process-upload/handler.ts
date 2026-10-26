import type { S3Event, S3EventRecord, SQSBatchResponse, SQSEvent, SQSRecord } from 'aws-lambda';
import { delegateFromEnv } from './batch-delegate';
import { processorDepsFromEnv } from './deps';
import { metricsLine, noMetrics, stdoutMetrics, type MetricSink, type Outcome } from './metrics';
import { processObject, type ProcessorDeps } from './processor';

/** `traceId` ties a log line to its X-Ray trace; Lambda sets the variable afresh for each invocation. */
const log = (message: string, fields: Record<string, unknown> = {}) =>
  console.log(JSON.stringify({ message, ...(process.env._X_AMZN_TRACE_ID ? { traceId: process.env._X_AMZN_TRACE_ID } : {}), ...fields }));

let cached: ProcessorDeps | undefined;

/** Built lazily so importing the module (e.g. in tests) needs no AWS configuration. */
function defaultDeps(): ProcessorDeps {
  cached ??= processorDepsFromEnv(process.env, log, { delegate: delegateFromEnv(process.env) });
  return cached;
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
export async function handleBatch(event: SQSEvent, deps: ProcessorDeps = defaultDeps(), metrics: MetricSink = noMetrics): Promise<SQSBatchResponse> {
  const batchItemFailures: SQSBatchResponse['batchItemFailures'] = [];
  for (const message of event.Records) {
    try {
      await handleMessage(message, deps, metrics);
    } catch (err) {
      (deps.log ?? log)('message failed', { messageId: message.messageId, error: err instanceof Error ? err.message : String(err) });
      batchItemFailures.push({ itemIdentifier: message.messageId });
    }
  }
  return { batchItemFailures };
}

async function handleMessage(message: SQSRecord, deps: ProcessorDeps, metrics: MetricSink): Promise<void> {
  const parsed = parseBody(message.body);
  if (parsed.kind === 'ignore') return;
  const now = deps.now ?? (() => new Date());
  const receiveCount = Number(message.attributes?.ApproximateReceiveCount ?? 1);
  // Only the first attempt says how long an object waited in the queue; later ones also include retry delays.
  const sentAt = Number(message.attributes?.SentTimestamp);
  const queueLatencyMs = receiveCount === 1 && Number.isFinite(sentAt) ? Math.max(0, now().getTime() - sentAt) : undefined;
  for (const record of parsed.records) {
    const started = now().getTime();
    const report = (outcome: Outcome, bytes?: number) =>
      metrics(metricsLine({ outcome, processingMs: now().getTime() - started, bytes, queueLatencyMs }, now().getTime()));
    try {
      const result = await processObject(
        deps,
        { key: decodeKey(record.s3.object.key), versionId: record.s3.object.versionId, etag: record.s3.object.eTag },
        receiveCount,
      );
      report(result.type, result.type === 'processed' ? result.result.size : undefined);
    } catch (err) {
      report('error');
      throw err;
    }
  }
}

export const handler = (event: SQSEvent): Promise<SQSBatchResponse> => handleBatch(event, defaultDeps(), stdoutMetrics);
