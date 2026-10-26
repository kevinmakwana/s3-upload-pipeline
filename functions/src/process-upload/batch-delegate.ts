import { BatchClient, SubmitJobCommand } from '@aws-sdk/client-batch';
import type { FileRecord } from '@s3up/data';
import type { LargeObjectDelegate, ObjectRef } from './processor';

export interface BatchDelegateOptions {
  aboveBytes: number;
  jobQueue: string;
  jobDefinition: string;
}

/**
 * Hands an object to an AWS Batch job, which runs the same processing code with no 15-minute limit. The job
 * is told only which object to process; it reads the file record itself, so what it works from is current.
 */
export class BatchDelegate implements LargeObjectDelegate {
  readonly aboveBytes: number;

  constructor(
    private readonly client: Pick<BatchClient, 'send'>,
    private readonly options: BatchDelegateOptions,
  ) {
    this.aboveBytes = options.aboveBytes;
  }

  async submit(ref: ObjectRef, file: FileRecord): Promise<void> {
    const environment = [
      { name: 'OBJECT_KEY', value: ref.key },
      ...(ref.versionId ? [{ name: 'OBJECT_VERSION_ID', value: ref.versionId }] : []),
      ...(ref.etag ? [{ name: 'OBJECT_ETAG', value: ref.etag }] : []),
    ];
    await this.client.send(
      new SubmitJobCommand({
        // The file id is in the name so a job in the Batch console or a failure notice says which file it is.
        jobName: `process-${file.id}`.replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 128),
        jobQueue: this.options.jobQueue,
        jobDefinition: this.options.jobDefinition,
        containerOverrides: { environment },
      }),
    );
  }
}

/** Set by the stack together; any one of them alone is a mistake worth failing on rather than silently not delegating. */
export function delegateFromEnv(env: NodeJS.ProcessEnv, client: Pick<BatchClient, 'send'> = new BatchClient({})): BatchDelegate | undefined {
  const { LARGE_OBJECT_BYTES: bytes, BATCH_JOB_QUEUE: jobQueue, BATCH_JOB_DEFINITION: jobDefinition } = env;
  if (!bytes && !jobQueue && !jobDefinition) return undefined;
  const aboveBytes = Number(bytes);
  if (!jobQueue || !jobDefinition || !Number.isFinite(aboveBytes) || aboveBytes < 0) {
    throw new Error('LARGE_OBJECT_BYTES, BATCH_JOB_QUEUE and BATCH_JOB_DEFINITION must be set together (bytes as a number)');
  }
  return new BatchDelegate(client, { aboveBytes, jobQueue, jobDefinition });
}
