import type { BatchClient } from '@aws-sdk/client-batch';
import { newRecord } from '../../../packages/data/src/testing/contract';
import { BatchDelegate, delegateFromEnv } from './batch-delegate';

const fakeBatch = () => {
  const sent: { input: Record<string, unknown> }[] = [];
  const client = { send: async (cmd: { input: Record<string, unknown> }) => (sent.push(cmd), {}) } as unknown as Pick<BatchClient, 'send'>;
  return { client, sent };
};
const options = { aboveBytes: 100, jobQueue: 'arn:aws:batch:us-east-1:1:job-queue/q', jobDefinition: 'arn:aws:batch:us-east-1:1:job-definition/d:3' };

describe('BatchDelegate', () => {
  it('submits one job naming the object, in the configured queue and definition, with the file id in the job name', async () => {
    const { client, sent } = fakeBatch();
    const file = newRecord({ id: 'file-123' });
    await new BatchDelegate(client, options).submit({ key: `uploads/alice/${file.id}/big name.bin`, versionId: 'v9', etag: '"abc"' }, file);

    expect(sent).toHaveLength(1);
    expect(sent[0]!.input).toEqual({
      jobName: 'process-file-123',
      jobQueue: options.jobQueue,
      jobDefinition: options.jobDefinition,
      containerOverrides: {
        environment: [
          { name: 'OBJECT_KEY', value: `uploads/alice/${file.id}/big name.bin` },
          { name: 'OBJECT_VERSION_ID', value: 'v9' },
          { name: 'OBJECT_ETAG', value: '"abc"' },
        ],
      },
    });
  });

  it('leaves out the version and etag when the object has none (an unversioned bucket)', async () => {
    const { client, sent } = fakeBatch();
    await new BatchDelegate(client, options).submit({ key: 'uploads/a/b/c' }, newRecord());
    expect((sent[0]!.input.containerOverrides as { environment: unknown[] }).environment).toEqual([{ name: 'OBJECT_KEY', value: 'uploads/a/b/c' }]);
  });

  it('turns anything Batch would reject in a job name into a hyphen, and stays within its length limit', async () => {
    const { client, sent } = fakeBatch();
    await new BatchDelegate(client, options).submit({ key: 'k' }, newRecord({ id: 'a b/c.d' + 'x'.repeat(200) }));
    const name = sent[0]!.input.jobName as string;
    expect(name).toMatch(/^[A-Za-z0-9_-]{1,128}$/);
    expect(name.startsWith('process-a-b-c-d')).toBe(true);
  });

  it('lets a failure to submit propagate, so the queue message is retried', async () => {
    const client = {
      send: async () => {
        throw new Error('ClientException');
      },
    } as unknown as Pick<BatchClient, 'send'>;
    await expect(new BatchDelegate(client, options).submit({ key: 'k' }, newRecord())).rejects.toThrow('ClientException');
  });
});

describe('delegateFromEnv', () => {
  const { client } = fakeBatch();
  it('is off when none of the settings are present', () => {
    expect(delegateFromEnv({}, client)).toBeUndefined();
  });

  it('is on with all three, taking the limit from LARGE_OBJECT_BYTES', () => {
    const d = delegateFromEnv({ LARGE_OBJECT_BYTES: '1073741824', BATCH_JOB_QUEUE: 'q', BATCH_JOB_DEFINITION: 'd' }, client);
    expect(d?.aboveBytes).toBe(1073741824);
  });

  it.each([
    ['only the limit', { LARGE_OBJECT_BYTES: '5' }],
    ['no queue', { LARGE_OBJECT_BYTES: '5', BATCH_JOB_DEFINITION: 'd' }],
    ['no definition', { LARGE_OBJECT_BYTES: '5', BATCH_JOB_QUEUE: 'q' }],
    ['a limit that is not a number', { LARGE_OBJECT_BYTES: 'lots', BATCH_JOB_QUEUE: 'q', BATCH_JOB_DEFINITION: 'd' }],
    ['a negative limit', { LARGE_OBJECT_BYTES: '-1', BATCH_JOB_QUEUE: 'q', BATCH_JOB_DEFINITION: 'd' }],
  ])('refuses %s, because quietly not delegating would send big files back to a worker that cannot finish them', (_name, env) => {
    expect(() => delegateFromEnv(env, client)).toThrow(/must be set together/);
  });
});
