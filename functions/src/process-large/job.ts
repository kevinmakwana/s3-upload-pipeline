import { LARGE_METRICS_NAMESPACE, metricsLine, stdoutMetrics, type MetricSink, type Outcome } from '../process-upload/metrics';
import { ProcessingInProgressError, idempotencyKey, processObject, type ProcessorDeps } from '../process-upload/processor';
import { processorDepsFromEnv, requiredEnv } from '../process-upload/deps';

export interface JobResult {
  /** 0 when the work is done or does not need doing; non-zero asks AWS Batch to try again. */
  exitCode: number;
  outcome: Outcome;
}

const log = (message: string, fields: Record<string, unknown> = {}) => console.log(JSON.stringify({ message, ...fields }));

/**
 * One AWS Batch job: process the one object named in the environment, with the same code and the same ledger as the
 * Lambda worker, and no time limit. Batch retries a non-zero exit, so only a failure that a retry could fix returns one.
 */
export async function runJob(
  env: NodeJS.ProcessEnv,
  deps: ProcessorDeps = processorDepsFromEnv(env, log),
  metrics: MetricSink = stdoutMetrics,
  clock: () => number = Date.now,
): Promise<JobResult> {
  const ref = { key: requiredEnv(env, 'OBJECT_KEY'), versionId: env.OBJECT_VERSION_ID || undefined, etag: env.OBJECT_ETAG || undefined };
  // Batch counts attempts from 1; the processor treats the last one as final and marks the file failed.
  const attempt = Number(env.AWS_BATCH_JOB_ATTEMPT ?? 1);
  const maxAttempts = Number(env.JOB_MAX_ATTEMPTS ?? 1);
  // This is the worker the Lambda hands off to: it must process in place, never pass the object on again.
  const jobDeps: ProcessorDeps = { ...deps, delegate: undefined, config: { ...deps.config, maxReceiveCount: maxAttempts } };

  // Batch retries only after the previous attempt has ended, so on a retry whatever lease it left (it was killed
  // before it could release it) belongs to nobody. Without this the retry would find the object "in progress",
  // stop as a duplicate, and the work would be lost. It does nothing if the object is already done.
  if (attempt > 1) await jobDeps.ledger.fail(idempotencyKey(ref), 'the previous attempt did not finish', new Date(clock()));

  const started = clock();
  const report = (outcome: Outcome, bytes?: number) =>
    metrics(metricsLine({ outcome, processingMs: clock() - started, bytes }, clock(), LARGE_METRICS_NAMESPACE));
  try {
    const result = await processObject(jobDeps, ref, attempt);
    report(result.type === 'delegated' ? 'ignored' : result.type, result.type === 'processed' ? result.result.size : undefined);
    return { exitCode: 0, outcome: result.type === 'delegated' ? 'ignored' : result.type };
  } catch (err) {
    if (err instanceof ProcessingInProgressError) {
      // Another job for this object is running; that one will finish it (or fail and be retried by Batch).
      log('another run holds this object; nothing to do', { key: ref.key });
      report('duplicate');
      return { exitCode: 0, outcome: 'duplicate' };
    }
    log('attempt failed', { key: ref.key, attempt, maxAttempts, error: err instanceof Error ? err.message : String(err) });
    report('error');
    return { exitCode: 1, outcome: 'error' };
  }
}
