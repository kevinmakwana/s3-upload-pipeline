/**
 * Worker metrics in CloudWatch's embedded metric format (EMF): one JSON log line per object that CloudWatch
 * turns into metrics, so the worker needs no SDK call, no extra permission and no network round trip.
 * https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/CloudWatch_Embedded_Metric_Format_Specification.html
 */

export const METRICS_NAMESPACE = 'S3Upload/Worker';
/** The large-object job publishes the same metrics here, so its long runs do not trip the Lambda worker's slow-object alarm. */
export const LARGE_METRICS_NAMESPACE = 'S3Upload/LargeWorker';

/** What happened to an object. A small, fixed set, because each value becomes its own metric series. */
export type Outcome = 'processed' | 'rejected' | 'duplicate' | 'ignored' | 'delegated' | 'error';

export interface ObjectMetrics {
  outcome: Outcome;
  /** Time spent on the object, in milliseconds. */
  processingMs: number;
  /** Bytes checksummed; only for objects that were processed. */
  bytes?: number;
  /** Time between S3's event being queued and the worker starting on it, in milliseconds. */
  queueLatencyMs?: number;
}

export type MetricSink = (line: string) => void;

export const noMetrics: MetricSink = () => undefined;
export const stdoutMetrics: MetricSink = (line) => console.log(line);

/**
 * Each metric is published twice: per outcome (to see rejected or failing files) and with no dimension (to alarm
 * on and graph the whole worker, e.g. the slowest object whatever its outcome).
 */
export function metricsLine(m: ObjectMetrics, now: number, namespace: string = METRICS_NAMESPACE): string {
  const metrics = [
    { Name: 'ObjectsHandled', Unit: 'Count' },
    { Name: 'ProcessingMs', Unit: 'Milliseconds' },
    ...(m.bytes === undefined ? [] : [{ Name: 'BytesProcessed', Unit: 'Bytes' }]),
    ...(m.queueLatencyMs === undefined ? [] : [{ Name: 'QueueLatencyMs', Unit: 'Milliseconds' }]),
  ];
  return JSON.stringify({
    _aws: {
      Timestamp: now,
      CloudWatchMetrics: [{ Namespace: namespace, Dimensions: [['Outcome'], []], Metrics: metrics }],
    },
    Outcome: m.outcome,
    ObjectsHandled: 1,
    ProcessingMs: m.processingMs,
    ...(m.bytes === undefined ? {} : { BytesProcessed: m.bytes }),
    ...(m.queueLatencyMs === undefined ? {} : { QueueLatencyMs: m.queueLatencyMs }),
  });
}
