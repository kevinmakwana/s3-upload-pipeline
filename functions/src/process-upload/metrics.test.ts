import { METRICS_NAMESPACE, metricsLine, type ObjectMetrics } from './metrics';

interface Emf {
  _aws: { Timestamp: number; CloudWatchMetrics: { Namespace: string; Dimensions: string[][]; Metrics: { Name: string; Unit: string }[] }[] };
  [member: string]: unknown;
}
const parse = (m: ObjectMetrics, now = 1_700_000_000_000) => JSON.parse(metricsLine(m, now)) as Emf;

describe('metricsLine (CloudWatch embedded metric format)', () => {
  it('is one JSON object whose directive names the namespace and a per-outcome and an all-outcomes dimension set', () => {
    const line = parse({ outcome: 'processed', processingMs: 1200, bytes: 4096, queueLatencyMs: 300 });
    expect(line._aws.Timestamp).toBe(1_700_000_000_000);
    expect(line._aws.CloudWatchMetrics).toHaveLength(1);
    const [directive] = line._aws.CloudWatchMetrics;
    expect(directive).toMatchObject({ Namespace: METRICS_NAMESPACE, Dimensions: [['Outcome'], []] });
    expect(line.Outcome).toBe('processed');
  });

  it('carries a numeric value at the root for every metric it declares, in a unit CloudWatch knows', () => {
    const line = parse({ outcome: 'processed', processingMs: 1200, bytes: 4096, queueLatencyMs: 300 });
    const declared = line._aws.CloudWatchMetrics[0]!.Metrics;
    expect(declared.map((m) => [m.Name, m.Unit])).toEqual([
      ['ObjectsHandled', 'Count'],
      ['ProcessingMs', 'Milliseconds'],
      ['BytesProcessed', 'Bytes'],
      ['QueueLatencyMs', 'Milliseconds'],
    ]);
    for (const { Name } of declared) expect(typeof line[Name]).toBe('number');
    expect(line).toMatchObject({ ObjectsHandled: 1, ProcessingMs: 1200, BytesProcessed: 4096, QueueLatencyMs: 300 });
  });

  it('leaves out the metrics it has no value for, rather than publishing zeros that would skew averages', () => {
    const line = parse({ outcome: 'rejected', processingMs: 40 });
    expect(line._aws.CloudWatchMetrics[0]!.Metrics.map((m) => m.Name)).toEqual(['ObjectsHandled', 'ProcessingMs']);
    expect(line).not.toHaveProperty('BytesProcessed');
    expect(line).not.toHaveProperty('QueueLatencyMs');
  });

  it('keeps a whole-number timestamp in milliseconds, which is what CloudWatch requires', () => {
    expect(Number.isInteger(parse({ outcome: 'ignored', processingMs: 0 })._aws.Timestamp)).toBe(true);
  });
});
