import { CreateQueueCommand, DeleteMessageBatchCommand, DeleteQueueCommand, GetQueueUrlCommand, ReceiveMessageCommand } from '@aws-sdk/client-sqs';
import { ListSubscriptionsByTopicCommand, SubscribeCommand, UnsubscribeCommand } from '@aws-sdk/client-sns';

type Send = (command: { constructor: { name: string }; input: Record<string, unknown> }, options?: { abortSignal?: AbortSignal }) => Promise<unknown>;

interface Queue {
  name: string;
  url: string;
  attributes: Record<string, string>;
  messages: { body: string; handle: string }[];
  waiter?: () => void;
}

/**
 * An in-memory SNS topic and SQS queues, just enough for the change feed: queues, raw-delivery subscriptions,
 * publishing, long-poll receives (that honour an abort signal) and deletes. Faults can be injected per command.
 */
export class FakeChangeBus {
  readonly queues = new Map<string, Queue>();
  readonly subscriptions = new Map<string, { arn: string; queueName: string }>();
  readonly calls: string[] = [];
  /** Commands that fail, by class name, with the error to throw. Cleared by setting to undefined. */
  failures = new Map<string, () => Error>();
  private counter = 0;

  readonly sqs = { send: ((command, options) => this.handle(command, options)) as Send };
  readonly sns = { send: ((command, options) => this.handle(command, options)) as Send };

  /** What the stream forwarder does: put `{ userId }` on every subscribed queue. */
  publish(userId: string, body = JSON.stringify({ userId })): void {
    for (const { queueName } of this.subscriptions.values()) this.deliver(this.queues.get(queueName), body);
  }

  /** A queue appears, as if another task had created it. `ageMs` back-dates the epoch in its name. */
  addForeignSubscription(queueName: string): void {
    this.queues.set(queueName, { name: queueName, url: `https://fake/${queueName}`, attributes: {}, messages: [] });
    const arn = `arn:aws:sns:us-east-1:111111111111:changes:foreign-${queueName}`;
    this.subscriptions.set(arn, { arn, queueName });
  }

  deleteQueueBehindTheirBack(queueName: string): void {
    this.queues.delete(queueName);
    for (const [arn, s] of this.subscriptions) if (s.queueName === queueName) this.subscriptions.delete(arn);
  }

  private deliver(queue: Queue | undefined, body: string): void {
    if (!queue) return;
    queue.messages.push({ body, handle: `h${++this.counter}` });
    queue.waiter?.();
  }

  private async handle(command: { constructor: { name: string }; input: Record<string, unknown> }, options?: { abortSignal?: AbortSignal }): Promise<unknown> {
    const name = command.constructor.name;
    this.calls.push(name);
    const fail = this.failures.get(name);
    if (fail) throw fail();
    const input = command.input;

    if (command instanceof CreateQueueCommand) {
      const queueName = String(input.QueueName);
      const queue: Queue = { name: queueName, url: `https://fake/${queueName}`, attributes: input.Attributes as Record<string, string>, messages: [] };
      this.queues.set(queueName, queue);
      return { QueueUrl: queue.url };
    }
    if (command instanceof SubscribeCommand) {
      const queueName = String(input.Endpoint).split(':').pop()!;
      const arn = `arn:aws:sns:us-east-1:111111111111:changes:sub-${++this.counter}`;
      this.subscriptions.set(arn, { arn, queueName });
      return { SubscriptionArn: arn };
    }
    if (command instanceof UnsubscribeCommand) {
      this.subscriptions.delete(String(input.SubscriptionArn));
      return {};
    }
    if (command instanceof ListSubscriptionsByTopicCommand) {
      return {
        Subscriptions: [...this.subscriptions.values()].map((s) => ({
          SubscriptionArn: s.arn,
          Protocol: 'sqs',
          Endpoint: `arn:aws:sqs:us-east-1:111111111111:${s.queueName}`,
        })),
      };
    }
    if (command instanceof DeleteQueueCommand) {
      const queue = [...this.queues.values()].find((q) => q.url === input.QueueUrl);
      if (queue) this.queues.delete(queue.name);
      return {};
    }
    if (command instanceof GetQueueUrlCommand) {
      const queue = this.queues.get(String(input.QueueName));
      if (!queue) throw Object.assign(new Error('The specified queue does not exist'), { name: 'QueueDoesNotExist' });
      return { QueueUrl: queue.url };
    }
    if (command instanceof ReceiveMessageCommand) return this.receive(String(input.QueueUrl), options?.abortSignal);
    if (command instanceof DeleteMessageBatchCommand) {
      const queue = [...this.queues.values()].find((q) => q.url === input.QueueUrl);
      const handles = new Set((input.Entries as { ReceiptHandle: string }[]).map((e) => e.ReceiptHandle));
      if (queue) queue.messages = queue.messages.filter((m) => !handles.has(m.handle));
      return {};
    }
    throw new Error(`FakeChangeBus does not implement ${name}`);
  }

  /** Returns waiting messages, or waits (briefly) for one, like a long poll. Fails like SQS if the queue is gone. */
  private receive(url: string, signal?: AbortSignal): Promise<{ Messages: { Body: string; ReceiptHandle: string }[] }> {
    const find = () => [...this.queues.values()].find((q) => q.url === url);
    const take = (queue: Queue) => ({ Messages: queue.messages.splice(0, 10).map((m) => ({ Body: m.body, ReceiptHandle: m.handle })) });
    return new Promise((resolve, reject) => {
      const queue = find();
      if (!queue) return reject(Object.assign(new Error('The specified queue does not exist'), { name: 'QueueDoesNotExist' }));
      if (queue.messages.length > 0) return resolve(take(queue));
      const finish = (fn: () => void) => {
        clearTimeout(timer);
        queue.waiter = undefined;
        signal?.removeEventListener('abort', onAbort);
        fn();
      };
      const onAbort = () => finish(() => reject(Object.assign(new Error('Aborted'), { name: 'AbortError' })));
      const timer = setTimeout(
        () =>
          finish(() =>
            find() ? resolve({ Messages: [] }) : reject(Object.assign(new Error('The specified queue does not exist'), { name: 'QueueDoesNotExist' })),
          ),
        25,
      );
      queue.waiter = () => finish(() => resolve(take(queue)));
      signal?.addEventListener('abort', onAbort, { once: true });
      if (signal?.aborted) onAbort();
    });
  }
}
