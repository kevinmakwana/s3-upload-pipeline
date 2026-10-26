import { randomUUID } from 'node:crypto';
import { MemoryFileStore, MemoryLedger, type FileRecord } from '@s3up/data';
import { newRecord } from '../../../packages/data/src/testing/contract';
import { idempotencyKey, type ProcessorDeps } from '../process-upload/processor';
import { FakeStorage } from '../testing/fake-storage';
import { runJob } from './job';

function setup() {
  const files = new MemoryFileStore();
  const ledger = new MemoryLedger();
  const storage = new FakeStorage();
  const deps: ProcessorDeps = { files, ledger, storage, config: { thumbnailMaxBytes: 1024, leaseMs: 60_000, maxReceiveCount: 3 }, log: () => undefined };
  const add = async (content: Buffer, overrides: Partial<FileRecord> = {}) => {
    const id = randomUUID();
    const record = newRecord({ id, userId: 'alice', size: content.length, s3Key: `uploads/alice/${id}/big.bin`, status: 'uploaded', ...overrides });
    await files.create(record);
    storage.objects.set(record.s3Key, content);
    return record;
  };
  const lines: Record<string, unknown>[] = [];
  const metrics = (l: string) => lines.push(JSON.parse(l));
  return { deps, files, ledger, storage, add, lines, metrics };
}
const envFor = (rec: FileRecord, extra: NodeJS.ProcessEnv = {}) => ({ OBJECT_KEY: rec.s3Key, OBJECT_VERSION_ID: 'v1', ...extra });

describe('runJob (the large-object worker)', () => {
  it('processes the named object and exits 0, reporting under the large-object namespace', async () => {
    const { deps, files, add, lines, metrics } = setup();
    const rec = await add(Buffer.from('twelve bytes'));
    const out = await runJob(envFor(rec), deps, metrics);

    expect(out).toEqual({ exitCode: 0, outcome: 'processed' });
    expect(await files.get(rec.id)).toMatchObject({ status: 'ready', result: { size: 12 } });
    expect(lines).toEqual([expect.objectContaining({ Outcome: 'processed', BytesProcessed: 12, ObjectsHandled: 1 })]);
    expect((lines[0]!._aws as { CloudWatchMetrics: { Namespace: string }[] }).CloudWatchMetrics[0]!.Namespace).toBe('S3Upload/LargeWorker');
  });

  it('never hands the object on again, even if it was given a delegate', async () => {
    const { deps, files, add, metrics } = setup();
    deps.delegate = { aboveBytes: 0, submit: async () => Promise.reject(new Error('would loop forever')) };
    const rec = await add(Buffer.from('abc'));
    expect((await runJob(envFor(rec), deps, metrics)).outcome).toBe('processed');
    expect((await files.get(rec.id))!.status).toBe('ready');
  });

  it('exits 0 for a file that was rejected: the verdict is final and a retry would reach the same one', async () => {
    const { deps, files, add, metrics } = setup();
    const rec = await add(Buffer.from('abc'), { size: 999 });
    expect(await runJob(envFor(rec), deps, metrics)).toEqual({ exitCode: 0, outcome: 'rejected' });
    expect((await files.get(rec.id))!.status).toBe('failed');
  });

  it('exits 0 when the work is already done (a repeated job), without doing it again', async () => {
    const { deps, storage, add, metrics } = setup();
    const rec = await add(Buffer.from('abc'));
    await runJob(envFor(rec), deps, metrics);
    const reads = storage.streamCalls;
    expect(await runJob(envFor(rec), deps, metrics)).toEqual({ exitCode: 0, outcome: 'duplicate' });
    expect(storage.streamCalls).toBe(reads);
  });

  it('exits 0 when another job holds the object, since that one will finish it or be retried by Batch', async () => {
    const { deps, ledger, add, metrics } = setup();
    const rec = await add(Buffer.from('abc'));
    await ledger.begin(idempotencyKey({ key: rec.s3Key, versionId: 'v1' }), new Date(), 60_000);
    expect(await runJob(envFor(rec), deps, metrics)).toEqual({ exitCode: 0, outcome: 'duplicate' });
  });

  it('takes over from an attempt that was killed without releasing the object, instead of mistaking it for a live run', async () => {
    const { deps, files, ledger, add, metrics } = setup();
    const rec = await add(Buffer.from('abc'));
    // Attempt 1 began and then died (out of memory, say): its lease is still held.
    await ledger.begin(idempotencyKey({ key: rec.s3Key, versionId: 'v1' }), new Date(), 24 * 3600_000);

    const retry = await runJob(envFor(rec, { AWS_BATCH_JOB_ATTEMPT: '2', JOB_MAX_ATTEMPTS: '3' }), deps, metrics);
    expect(retry).toEqual({ exitCode: 0, outcome: 'processed' });
    expect((await files.get(rec.id))!.status).toBe('ready');
  });

  it('does not take over on the first attempt, where a held lease means another job is genuinely running', async () => {
    const { deps, files, ledger, add, metrics } = setup();
    const rec = await add(Buffer.from('abc'));
    await ledger.begin(idempotencyKey({ key: rec.s3Key, versionId: 'v1' }), new Date(), 24 * 3600_000);
    expect(await runJob(envFor(rec, { AWS_BATCH_JOB_ATTEMPT: '1', JOB_MAX_ATTEMPTS: '3' }), deps, metrics)).toEqual({ exitCode: 0, outcome: 'duplicate' });
    expect((await files.get(rec.id))!.status).toBe('uploaded');
  });

  it('leaves finished work alone on a retry', async () => {
    const { deps, storage, add, metrics } = setup();
    const rec = await add(Buffer.from('abc'));
    await runJob(envFor(rec), deps, metrics);
    const reads = storage.streamCalls;
    expect(await runJob(envFor(rec, { AWS_BATCH_JOB_ATTEMPT: '2', JOB_MAX_ATTEMPTS: '3' }), deps, metrics)).toEqual({ exitCode: 0, outcome: 'duplicate' });
    expect(storage.streamCalls).toBe(reads);
  });

  it('exits non-zero on a failure a retry could fix, and leaves the file for that retry', async () => {
    const { deps, files, storage, add, lines, metrics } = setup();
    const rec = await add(Buffer.from('abc'));
    storage.failStream = 1;
    const out = await runJob(envFor(rec, { AWS_BATCH_JOB_ATTEMPT: '1', JOB_MAX_ATTEMPTS: '3' }), deps, metrics);

    expect(out).toEqual({ exitCode: 1, outcome: 'error' });
    expect((await files.get(rec.id))!.status).not.toBe('failed');
    expect(lines).toEqual([expect.objectContaining({ Outcome: 'error' })]);
  });

  it('succeeds on the retry after a transient failure', async () => {
    const { deps, files, storage, add, metrics } = setup();
    const rec = await add(Buffer.from('abc'));
    storage.failStream = 1;
    await runJob(envFor(rec, { AWS_BATCH_JOB_ATTEMPT: '1', JOB_MAX_ATTEMPTS: '3' }), deps, metrics);
    const second = await runJob(envFor(rec, { AWS_BATCH_JOB_ATTEMPT: '2', JOB_MAX_ATTEMPTS: '3' }), deps, metrics);
    expect(second).toEqual({ exitCode: 0, outcome: 'processed' });
    expect((await files.get(rec.id))!.status).toBe('ready');
  });

  it('marks the file failed, saying so, when the last attempt fails, so it is not left processing forever', async () => {
    const { deps, files, storage, add, metrics } = setup();
    const rec = await add(Buffer.from('abc'));
    storage.failStream = 5;
    const out = await runJob(envFor(rec, { AWS_BATCH_JOB_ATTEMPT: '3', JOB_MAX_ATTEMPTS: '3' }), deps, metrics);
    expect(out.exitCode).toBe(1);
    expect(await files.get(rec.id)).toMatchObject({ status: 'failed', error: expect.stringContaining('after 3 attempts') });
  });

  it('treats a run with no attempt settings as the first and only attempt', async () => {
    const { deps, files, storage, add, metrics } = setup();
    const rec = await add(Buffer.from('abc'));
    storage.failStream = 5;
    await runJob(envFor(rec), deps, metrics);
    expect((await files.get(rec.id))!.status).toBe('failed');
  });

  it('refuses to run without an object to process', async () => {
    const { deps, metrics } = setup();
    await expect(runJob({}, deps, metrics)).rejects.toThrow('OBJECT_KEY');
  });
});
