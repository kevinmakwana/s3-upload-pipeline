import type { SNSClient } from '@aws-sdk/client-sns';
import type { SQSClient } from '@aws-sdk/client-sqs';
import { FakeChangeBus } from '../testing/fake-change-bus';
import { SnsSqsChangeFeed, type SnsSqsFeedOptions } from './sns-sqs-change-feed';

const TOPIC = 'arn:aws:sns:us-east-1:111111111111:changes';
const PREFIX = 'Stack-sse';
const DAY = 24 * 3600_000;

const feeds: SnsSqsChangeFeed[] = [];
const listeners: { unsubscribe(): void }[] = [];
afterEach(async () => {
  for (const l of listeners.splice(0)) l.unsubscribe();
  for (const feed of feeds.splice(0)) await feed.onApplicationShutdown();
});

function setup(options: Partial<SnsSqsFeedOptions> = {}) {
  const bus = new FakeChangeBus();
  const logs: { level: string; message: string; fields?: Record<string, unknown> }[] = [];
  const feed = new SnsSqsChangeFeed(bus.sqs as unknown as Pick<SQSClient, 'send'>, bus.sns as unknown as Pick<SNSClient, 'send'>, {
    topicArn: TOPIC,
    queuePrefix: PREFIX,
    safetyPollMs: 60_000,
    fallbackPollMs: 60_000,
    retryMs: 5,
    log: (level, message, fields) => logs.push({ level, message, fields }),
    ...options,
  });
  feeds.push(feed);
  return { bus, feed, logs };
}

/** Subscribes and counts wake-ups for one user. */
function listen(feed: SnsSqsChangeFeed, userId: string) {
  const counter = { count: 0 };
  const subscription = feed.changes(userId).subscribe(() => counter.count++);
  listeners.push(subscription);
  return { counter, stop: () => subscription.unsubscribe() };
}

const until = async (condition: () => boolean, what: string) => {
  const deadline = Date.now() + 2000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 2));
  }
};

/** Starts the feed and waits until it is listening to its queue. */
async function start(bus: FakeChangeBus, feed: SnsSqsChangeFeed) {
  feed.onModuleInit();
  await until(() => bus.subscriptions.size === 1 && bus.calls.includes('ReceiveMessageCommand'), 'the feed to be listening');
}

describe('SnsSqsChangeFeed', () => {
  it('creates its own queue under the prefix, lets only the topic write to it, and subscribes it with raw delivery', async () => {
    const { bus, feed } = setup();
    await start(bus, feed);
    const [queue] = [...bus.queues.values()];
    expect(queue!.name).toMatch(new RegExp(`^${PREFIX}-\\d{10}-[0-9a-f]{8}$`));
    const policy = JSON.parse(queue!.attributes.Policy!);
    expect(policy.Statement).toEqual([
      expect.objectContaining({
        Principal: { Service: 'sns.amazonaws.com' },
        Action: 'sqs:SendMessage',
        Resource: `arn:aws:sqs:us-east-1:111111111111:${queue!.name}`,
        Condition: { ArnEquals: { 'aws:SourceArn': TOPIC } },
      }),
    ]);
    expect(queue!.attributes).toMatchObject({ SqsManagedSseEnabled: 'true', MessageRetentionPeriod: '120' });
  });

  it('wakes only the listeners of the user a message names, and removes the message once it has been handled', async () => {
    const { bus, feed } = setup();
    await start(bus, feed);
    const alice = listen(feed, 'alice');
    const bob = listen(feed, 'bob');

    bus.publish('alice');
    await until(() => alice.counter.count === 1, 'alice to be woken');
    await until(() => [...bus.queues.values()][0]!.messages.length === 0, 'the message to be deleted');
    expect(bob.counter.count).toBe(0);
  });

  it('wakes a user once for a burst of messages about them', async () => {
    const { bus, feed } = setup();
    await start(bus, feed);
    const alice = listen(feed, 'alice');
    // Messages already waiting are received together.
    const queue = [...bus.queues.values()][0]!;
    for (let i = 0; i < 5; i++) queue.messages.push({ body: JSON.stringify({ userId: 'alice' }), handle: `x${i}` });
    queue.waiter?.();
    await until(() => alice.counter.count >= 1, 'alice to be woken');
    await new Promise((r) => setTimeout(r, 30)); // a second wake-up, if there were going to be one, would have come by now
    expect(alice.counter.count).toBe(1);
  });

  it('ignores messages that are not for the feed, but still removes them', async () => {
    const { bus, feed } = setup();
    await start(bus, feed);
    const alice = listen(feed, 'alice');
    for (const body of ['not json', '{}', '{"userId":5}', '{"userId":""}']) bus.publish('x', body);
    await until(() => [...bus.queues.values()][0]!.messages.length === 0, 'the messages to be removed');
    expect(alice.counter.count).toBe(0);
  });

  it('stops waking a listener that has unsubscribed', async () => {
    const { bus, feed } = setup();
    await start(bus, feed);
    const alice = listen(feed, 'alice');
    alice.stop();
    alice.counter.count = 0;
    bus.publish('alice');
    await until(() => [...bus.queues.values()][0]!.messages.length === 0, 'the message to be handled');
    expect(alice.counter.count).toBe(0);
  });

  it('removes its subscription and its queue on shutdown, and stops promptly', async () => {
    const { bus, feed } = setup();
    await start(bus, feed);
    await feed.onApplicationShutdown();
    expect(bus.subscriptions.size).toBe(0);
    expect(bus.queues.size).toBe(0);
  });

  it('carries on if the queue is removed underneath it: registers a new one and has every listener look again', async () => {
    const { bus, feed, logs } = setup();
    await start(bus, feed);
    const alice = listen(feed, 'alice');
    const [first] = [...bus.queues.keys()];

    bus.deleteQueueBehindTheirBack(first!);
    await until(() => bus.subscriptions.size === 1 && !bus.queues.has(first!), 'a replacement queue');
    await until(() => alice.counter.count >= 1, 'listeners to look again');
    expect(logs.some((l) => l.level === 'error' && l.fields?.willRegisterAgain === true)).toBe(true);

    alice.counter.count = 0;
    bus.publish('alice');
    await until(() => alice.counter.count >= 1, 'the new queue to deliver');
  });

  it('polls at the fallback rate while it cannot set up, says why, and recovers by itself', async () => {
    const { bus, feed, logs } = setup({ fallbackPollMs: 10, safetyPollMs: 60_000 });
    let broken = true;
    bus.failures.set('CreateQueueCommand', () => (broken ? new Error('AccessDenied') : (undefined as never)));
    const alice = listen(feed, 'alice');
    feed.onModuleInit();

    await until(() => alice.counter.count >= 3, 'fallback polling');
    expect(logs.find((l) => l.level === 'error')?.fields?.error).toContain('AccessDenied');
    expect(bus.subscriptions.size).toBe(0);

    broken = false;
    bus.failures.delete('CreateQueueCommand');
    await until(() => bus.subscriptions.size === 1, 'recovery');
    // Working again, it falls back to the (long) safety interval, so the polling stops.
    const before = alice.counter.count;
    await new Promise((r) => setTimeout(r, 60));
    expect(alice.counter.count - before).toBeLessThanOrEqual(2);
  });

  it('does not leave a queue behind when subscribing fails', async () => {
    const { bus, feed } = setup();
    bus.failures.set('SubscribeCommand', () => new Error('AuthorizationError'));
    feed.onModuleInit();
    await until(() => bus.calls.includes('SubscribeCommand') && bus.calls.includes('DeleteQueueCommand'), 'the clean-up');
    expect(bus.queues.size).toBe(0);
  });

  it('re-reads on the safety interval even when no message arrives, so a lost message heals', async () => {
    const { bus, feed } = setup({ safetyPollMs: 15 });
    feed.onModuleInit();
    await until(() => bus.subscriptions.size === 1, 'the subscription');
    const alice = listen(feed, 'alice');
    await until(() => alice.counter.count >= 3, 'safety wake-ups');
  });

  describe('orphans', () => {
    const now = 1_800_000_000_000;
    const orphanName = (ageMs: number) => `${PREFIX}-${Math.floor((now - ageMs) / 1000)}-deadbeef`;

    it('removes queues that a stopped task left behind once they are old enough, and nothing else', async () => {
      const { bus, feed } = setup({ now: () => now });
      const stale = orphanName(8 * DAY);
      const recent = orphanName(1 * DAY);
      const otherStack = `Other-sse-${Math.floor((now - 30 * DAY) / 1000)}-deadbeef`;
      for (const name of [stale, recent, otherStack]) bus.addForeignSubscription(name);

      feed.onModuleInit();
      await until(() => !bus.queues.has(stale), 'the stale queue to be removed');
      expect([...bus.queues.keys()].filter((n) => n !== stale && !n.startsWith(`${PREFIX}-${Math.floor(now / 1000)}`)).sort()).toEqual(
        [otherStack, recent].sort(),
      );
      expect([...bus.subscriptions.values()].map((s) => s.queueName)).not.toContain(stale);
      expect([...bus.subscriptions.values()].map((s) => s.queueName)).toEqual(expect.arrayContaining([recent, otherStack]));
    });

    it('never removes its own queue, however old the clock says it is', async () => {
      const { bus, feed } = setup({ now: () => now, orphanAgeMs: 0 });
      feed.onModuleInit();
      await until(() => bus.calls.includes('ListSubscriptionsByTopicCommand'), 'the sweep');
      await new Promise((r) => setTimeout(r, 20));
      expect(bus.subscriptions.size).toBe(1);
      expect(bus.queues.size).toBe(1);
    });

    it('carries on if the sweep fails', async () => {
      const { bus, feed, logs } = setup();
      bus.failures.set('ListSubscriptionsByTopicCommand', () => new Error('AccessDenied'));
      feed.onModuleInit();
      await until(() => logs.some((l) => l.message.includes('could not sweep')), 'the warning');
      expect(bus.subscriptions.size).toBe(1);
    });
  });
});
