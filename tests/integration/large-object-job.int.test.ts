import { createHash, randomUUID } from 'node:crypto';
import { DeleteObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { createDocClient, createS3Client, DynamoFileStore } from '@s3up/data';
import { runJob } from '../../functions/src/process-large/job';
import { newRecord } from '../../packages/data/src/testing/contract';

/**
 * Runs the large-object job's code against the LocalStack stack, as the Batch container would (AWS Batch itself
 * is not available in LocalStack). The object is written before its file record exists, so the Lambda worker,
 * which also hears about it, finds nothing to process and ignores it; the job then does the work.
 */
const s3 = createS3Client();
const files = new DynamoFileStore(createDocClient(), process.env.TABLE_NAME!);
const bucket = process.env.BUCKET_NAME!;

describe('large-object job', () => {
  it('checksums a stored object, writes the result to its record, and exits 0', async () => {
    const userId = `job-${Math.random().toString(36).slice(2, 8)}`;
    const id = randomUUID();
    const key = `uploads/${userId}/${id}/big.bin`;
    // 24 MiB of repeating, non-trivial bytes, so a wrong range or a truncated read would change the hash.
    const body = Buffer.alloc(24 * 1024 * 1024);
    for (let i = 0; i < body.length; i++) body[i] = (i * 31 + (i >> 8)) & 0xff;
    const { VersionId } = await s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: 'application/octet-stream' }));

    // Let the Lambda worker see the upload event and ignore it for want of a record.
    await new Promise((r) => setTimeout(r, 8_000));
    await files.create(newRecord({ id, userId, s3Key: key, size: body.length, status: 'uploaded', contentType: 'application/octet-stream' }));

    const lines: string[] = [];
    const out = await runJob(
      { ...process.env, OBJECT_KEY: key, OBJECT_VERSION_ID: VersionId, AWS_BATCH_JOB_ATTEMPT: '1', JOB_MAX_ATTEMPTS: '3' },
      undefined,
      (l) => lines.push(l),
    );

    expect(out.exitCode).toBe(0);
    const record = await files.get(id);
    expect(record).toMatchObject({ status: 'ready', result: { sha256: createHash('sha256').update(body).digest('hex'), size: body.length } });
    // It reported under its own namespace, with the object's size.
    const metric = JSON.parse(lines.at(-1)!) as { _aws: { CloudWatchMetrics: { Namespace: string }[] }; Outcome: string; BytesProcessed?: number };
    expect(metric._aws.CloudWatchMetrics[0]!.Namespace).toBe('S3Upload/LargeWorker');
    if (out.outcome === 'processed') expect(metric.BytesProcessed).toBe(body.length);

    await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key, VersionId }));
    await files.markFailed(id, 'test clean-up', new Date().toISOString());
  });

  it('exits 0 and changes nothing for a repeated job on a finished object', async () => {
    const userId = `job-${Math.random().toString(36).slice(2, 8)}`;
    const id = randomUUID();
    const key = `uploads/${userId}/${id}/small.bin`;
    const { VersionId } = await s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: Buffer.from('tiny'), ContentType: 'application/octet-stream' }));
    await new Promise((r) => setTimeout(r, 8_000));
    await files.create(newRecord({ id, userId, s3Key: key, size: 4, status: 'uploaded', contentType: 'application/octet-stream' }));

    const env = { ...process.env, OBJECT_KEY: key, OBJECT_VERSION_ID: VersionId };
    expect((await runJob(env, undefined, () => undefined)).exitCode).toBe(0);
    const first = await files.get(id);
    expect(first!.status).toBe('ready');
    const again = await runJob(env, undefined, () => undefined);
    expect(again).toEqual({ exitCode: 0, outcome: 'duplicate' });
    expect(await files.get(id)).toEqual(first);
  });
});
