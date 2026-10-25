import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ListSubscriptionsByTopicCommand, SNSClient } from '@aws-sdk/client-sns';
import { MemoryResumeStore, Upload, type FilePage } from '@s3up/core';
import { watchFiles } from '../../apps/web/src/lib/sse';
import { FetchTransport, NodeFileSource, startApi, type RunningApi } from './harness';

/**
 * The live file list is woken by change notifications: DynamoDB Streams -> forwarder Lambda -> SNS topic -> the
 * API task's own SQS queue. Polling and the safety re-read are set to a minute here, so an update that shows up
 * within seconds can only have travelled that whole path.
 */
const LONG = String(60_000);

let server: RunningApi;
let dir: string;
const aborts: AbortController[] = [];

beforeAll(async () => {
  server = await startApi({ SSE_POLL_MS: LONG, SSE_SAFETY_POLL_MS: LONG });
  dir = await mkdtemp(join(tmpdir(), 's3up-live-'));
});
afterAll(async () => {
  aborts.forEach((a) => a.abort());
  await server?.close();
  await rm(dir, { recursive: true, force: true });
});

const until = async <T>(read: () => T | undefined, what: string, timeoutMs: number): Promise<T> => {
  const start = Date.now();
  for (;;) {
    const value = read();
    if (value !== undefined) return value;
    if (Date.now() - start > timeoutMs) throw new Error(`Timed out after ${timeoutMs} ms waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
};

/** The API's queue is subscribed to the topic, which is when pushes can reach it. */
async function waitUntilSubscribed(): Promise<void> {
  const sns = new SNSClient({});
  const topicArn = process.env.CHANGES_TOPIC_ARN!;
  const start = Date.now();
  for (;;) {
    const { Subscriptions = [] } = await sns.send(new ListSubscriptionsByTopicCommand({ TopicArn: topicArn }));
    if (Subscriptions.some((s) => s.Endpoint?.includes(process.env.CHANGES_QUEUE_PREFIX!))) return;
    if (Date.now() - start > 30_000) throw new Error('The API never subscribed its queue to the changes topic');
    await new Promise((r) => setTimeout(r, 250));
  }
}

describe('live updates', () => {
  it('shows a new file, and then its processed result, on an open stream within seconds', async () => {
    const user = `live-${Math.random().toString(36).slice(2, 10)}`;
    const pages: { at: number; page: FilePage }[] = [];
    const abort = new AbortController();
    aborts.push(abort);
    void watchFiles({
      baseUrl: server.url,
      getHeaders: async () => ({ 'x-user-id': user }),
      onFiles: (page) => pages.push({ at: Date.now(), page }),
      onState: () => undefined,
      signal: abort.signal,
    });

    // The first page is the list as it stands when the connection opens: empty.
    await until(() => pages[0], 'the first page', 15_000);
    expect(pages[0]!.page.files).toEqual([]);
    await waitUntilSubscribed();
    // The queue is created, then subscribed, then listened to; give the first receive a moment to start.
    await new Promise((r) => setTimeout(r, 500));

    const path = join(dir, 'note.txt');
    await writeFile(path, 'hello from the live updates test');
    const source = await NodeFileSource.open(path);
    const startedAt = Date.now();
    const uploading = new Upload(
      { api: server.apiFor(user), transport: new FetchTransport(), store: new MemoryResumeStore() },
      source,
      { fileName: 'note.txt', contentType: 'text/plain', lastModified: 1 },
      { concurrency: 2, maxRetries: 3, baseDelayMs: 50, maxDelayMs: 500 },
    ).start();

    // Appears while uploading...
    const appeared = await until(() => pages.find((p) => p.page.files.some((f) => f.fileName === 'note.txt')), 'the new file to appear', 20_000);
    expect(appeared.at - startedAt).toBeLessThan(20_000);
    await uploading;
    await source.close();

    // ...and becomes ready once the worker has processed it: a change made by a different component entirely.
    const ready = await until(
      () => pages.find((p) => p.page.files.some((f) => f.fileName === 'note.txt' && f.status === 'ready')),
      'the file to be ready',
      120_000,
    );
    expect(ready.page.files[0]).toMatchObject({ fileName: 'note.txt', status: 'ready' });
    // Had it relied on a timer, nothing would have arrived for a minute.
    expect(pages.length).toBeGreaterThanOrEqual(2);
  });

  it("does not show one user another user's files", async () => {
    const alice = `live-a-${Math.random().toString(36).slice(2, 8)}`;
    const bob = `live-b-${Math.random().toString(36).slice(2, 8)}`;
    const names: string[] = [];
    let pages = 0;
    const abort = new AbortController();
    aborts.push(abort);
    void watchFiles({
      baseUrl: server.url,
      getHeaders: async () => ({ 'x-user-id': alice }),
      onFiles: (page) => {
        pages++;
        names.push(...page.files.map((f) => f.fileName));
      },
      onState: () => undefined,
      signal: abort.signal,
    });
    await until(() => (pages > 0 ? true : undefined), "alice's first page", 15_000);
    await waitUntilSubscribed();

    const path = join(dir, 'bobs.txt');
    await writeFile(path, 'bob only');
    const source = await NodeFileSource.open(path);
    const outcome = await new Upload(
      { api: server.apiFor(bob), transport: new FetchTransport(), store: new MemoryResumeStore() },
      source,
      { fileName: 'bobs.txt', contentType: 'text/plain', lastModified: 1 },
      { concurrency: 2, maxRetries: 3, baseDelayMs: 50, maxDelayMs: 500 },
    ).start();
    await source.close();
    expect(outcome.type).toBe('done');
    // Long enough for the notification to have crossed the whole path, had it been going to.
    await new Promise((r) => setTimeout(r, 4_000));
    expect(names).toEqual([]);
  });
});
