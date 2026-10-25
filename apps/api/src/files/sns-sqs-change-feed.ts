import { randomUUID } from 'node:crypto';
import {
  CreateQueueCommand,
  DeleteMessageBatchCommand,
  DeleteQueueCommand,
  GetQueueUrlCommand,
  ReceiveMessageCommand,
  type SQSClient,
} from '@aws-sdk/client-sqs';
import { ListSubscriptionsByTopicCommand, SubscribeCommand, UnsubscribeCommand, type SNSClient } from '@aws-sdk/client-sns';
import { Observable } from 'rxjs';
import type { LogFields, LogLevel } from '../common/logger';
import type { ChangeFeed } from './change-feed';

export interface SnsSqsFeedOptions {
  /** The topic the stream forwarder publishes `{ userId }` to when a user's files change. */
  topicArn: string;
  /** Every queue this feed creates starts with this, which is also all the task's IAM permissions cover. */
  queuePrefix: string;
  /** While the feed works, how often a listener re-reads anyway, so a lost message heals itself. */
  safetyPollMs: number;
  /** While the feed is down, how often a listener re-reads, which is plain polling. */
  fallbackPollMs: number;
  /** A queue this old that is not ours was left by a task that died without cleaning up. */
  orphanAgeMs?: number;
  /** Seconds one receive call waits for a message. */
  waitSeconds?: number;
  /** First pause after a failure; doubles up to 30 seconds. */
  retryMs?: number;
  log?: (level: LogLevel, message: string, fields?: LogFields) => void;
  now?: () => number;
}

const DAY_MS = 24 * 3600_000;
const MAX_RETRY_MS = 30_000;

/**
 * Push-style change notifications for a fleet of API tasks. A stream forwarder publishes to an SNS topic; each task
 * owns one SQS queue subscribed to it, and wakes the listeners of whichever users the messages name. Open
 * connections therefore cost nothing while nothing changes, where polling costs a read a second for each.
 *
 * It must never take the API down: if the queue cannot be set up it logs, listeners fall back to polling, and it
 * keeps retrying. Its queue is removed on shutdown; queues left behind by a task that was killed are removed by
 * the next task that starts, after `orphanAgeMs`.
 */
export class SnsSqsChangeFeed implements ChangeFeed {
  private readonly listeners = new Map<string, Set<() => void>>();
  private readonly abort = new AbortController();
  private registration?: { queueUrl: string; queueName: string; subscriptionArn: string };
  private working = false;
  private stopped = false;
  private loop?: Promise<void>;

  constructor(
    private readonly sqs: Pick<SQSClient, 'send'>,
    private readonly sns: Pick<SNSClient, 'send'>,
    private readonly options: SnsSqsFeedOptions,
  ) {}

  /** Nest calls this once the module is built. It does not wait: the API can serve before the feed is ready. */
  onModuleInit(): void {
    this.loop = this.run();
  }

  /** Stops listening and removes this task's queue and subscription, so nothing is left behind on a clean stop. */
  async onApplicationShutdown(): Promise<void> {
    this.stopped = true;
    this.abort.abort();
    await this.loop;
    await this.unregister();
  }

  changes(userId: string): Observable<void> {
    return new Observable<void>((subscriber) => {
      const wake = () => subscriber.next();
      let set = this.listeners.get(userId);
      if (!set) this.listeners.set(userId, (set = new Set()));
      set.add(wake);

      let timer: NodeJS.Timeout;
      const schedule = () => {
        timer = setTimeout(
          () => {
            subscriber.next();
            schedule();
          },
          this.working ? this.options.safetyPollMs : this.options.fallbackPollMs,
        );
      };
      schedule();

      return () => {
        clearTimeout(timer);
        set.delete(wake);
        if (set.size === 0) this.listeners.delete(userId);
      };
    });
  }

  private async run(): Promise<void> {
    let failures = 0;
    while (!this.stopped) {
      try {
        if (!this.registration) {
          await this.register();
          this.working = true;
          // Anything that changed while there was no queue was missed: have every listener look again.
          this.wakeAll();
          void this.sweepOrphans();
        }
        await this.receive();
        failures = 0;
      } catch (err) {
        if (this.stopped) break;
        this.working = false;
        if (isQueueGone(err)) this.registration = undefined;
        this.log('error', 'change feed failed; listeners are polling until it recovers', { error: errorText(err), willRegisterAgain: !this.registration });
        await this.pause(Math.min(MAX_RETRY_MS, (this.options.retryMs ?? 1000) * 2 ** failures++));
      }
    }
  }

  private async register(): Promise<void> {
    const { topicArn, queuePrefix } = this.options;
    const queueName = `${queuePrefix}-${Math.floor(this.now() / 1000)}-${randomUUID().slice(0, 8)}`;
    const queueArn = queueArnFor(topicArn, queueName);
    const { QueueUrl: queueUrl } = await this.sqs.send(
      new CreateQueueCommand({
        QueueName: queueName,
        Attributes: {
          // A notification is worthless after a couple of minutes: the safety poll covers anything later.
          MessageRetentionPeriod: '120',
          ReceiveMessageWaitTimeSeconds: String(this.options.waitSeconds ?? 20),
          SqsManagedSseEnabled: 'true',
          // Only this topic may put messages in the queue.
          Policy: JSON.stringify({
            Version: '2012-10-17',
            Statement: [
              {
                Sid: 'FromTheChangesTopic',
                Effect: 'Allow',
                Principal: { Service: 'sns.amazonaws.com' },
                Action: 'sqs:SendMessage',
                Resource: queueArn,
                Condition: { ArnEquals: { 'aws:SourceArn': topicArn } },
              },
            ],
          }),
        },
      }),
    );
    if (!queueUrl) throw new Error('SQS did not return a queue URL');
    try {
      const { SubscriptionArn } = await this.sns.send(
        new SubscribeCommand({
          TopicArn: topicArn,
          Protocol: 'sqs',
          Endpoint: queueArn,
          Attributes: { RawMessageDelivery: 'true' },
          ReturnSubscriptionArn: true,
        }),
      );
      if (!SubscriptionArn) throw new Error('SNS did not return a subscription ARN');
      this.registration = { queueUrl, queueName, subscriptionArn: SubscriptionArn };
    } catch (err) {
      // Do not leave a queue that nothing feeds.
      await this.sqs.send(new DeleteQueueCommand({ QueueUrl: queueUrl })).catch(() => undefined);
      throw err;
    }
    this.log('info', 'change feed ready', { queue: queueName });
  }

  private async receive(): Promise<void> {
    const { queueUrl } = this.registration!;
    const { Messages = [] } = await this.sqs.send(new ReceiveMessageCommand({ QueueUrl: queueUrl, MaxNumberOfMessages: 10 }), {
      abortSignal: this.abort.signal,
    });
    this.working = true; // also the way back from a failed receive
    if (Messages.length === 0) return;
    const users = new Set<string>();
    for (const message of Messages) {
      const userId = userIdOf(message.Body);
      if (userId) users.add(userId);
    }
    // Wake before deleting: if the delete fails the messages come back, and a repeat wake-up is harmless.
    for (const userId of users) this.listeners.get(userId)?.forEach((wake) => wake());
    await this.sqs.send(
      new DeleteMessageBatchCommand({
        QueueUrl: queueUrl,
        Entries: Messages.map((m, i) => ({ Id: String(i), ReceiptHandle: m.ReceiptHandle! })),
      }),
    );
  }

  private async unregister(): Promise<void> {
    const registration = this.registration;
    this.registration = undefined;
    if (!registration) return;
    await this.sns
      .send(new UnsubscribeCommand({ SubscriptionArn: registration.subscriptionArn }))
      .catch((err) => this.log('warn', 'could not unsubscribe', { error: errorText(err) }));
    await this.sqs
      .send(new DeleteQueueCommand({ QueueUrl: registration.queueUrl }))
      .catch((err) => this.log('warn', 'could not delete the queue', { error: errorText(err) }));
  }

  /** Removes subscriptions and queues that a task which was killed left behind. Best effort: it only ever logs. */
  private async sweepOrphans(): Promise<void> {
    const { topicArn, queuePrefix, orphanAgeMs = 7 * DAY_MS } = this.options;
    const pattern = new RegExp(`^${queuePrefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-(\\d{10})-[0-9a-f]{8}$`);
    try {
      let token: string | undefined;
      do {
        const page = await this.sns.send(new ListSubscriptionsByTopicCommand({ TopicArn: topicArn, NextToken: token }));
        for (const subscription of page.Subscriptions ?? []) {
          const name = subscription.Endpoint?.split(':').pop() ?? '';
          const startedAt = Number(pattern.exec(name)?.[1]) * 1000;
          if (!startedAt || name === this.registration?.queueName || this.now() - startedAt < orphanAgeMs) continue;
          await this.sns.send(new UnsubscribeCommand({ SubscriptionArn: subscription.SubscriptionArn }));
          const queue = await this.sqs.send(new GetQueueUrlCommand({ QueueName: name })).catch(() => undefined);
          if (queue?.QueueUrl) await this.sqs.send(new DeleteQueueCommand({ QueueUrl: queue.QueueUrl }));
          this.log('info', 'removed a change feed queue left by a stopped task', { queue: name });
        }
        token = page.NextToken;
      } while (token);
    } catch (err) {
      this.log('warn', 'could not sweep old change feed queues', { error: errorText(err) });
    }
  }

  private wakeAll(): void {
    for (const set of this.listeners.values()) set.forEach((wake) => wake());
  }

  private pause(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      this.abort.signal.addEventListener('abort', () => (clearTimeout(timer), resolve()), { once: true });
    });
  }

  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  private log(level: LogLevel, message: string, fields?: LogFields): void {
    this.options.log?.(level, message, fields);
  }
}

/** `{ "userId": "..." }`, as the forwarder publishes it. Anything else is not for us. */
function userIdOf(body: string | undefined): string | undefined {
  try {
    const userId = (JSON.parse(body ?? '') as { userId?: unknown }).userId;
    return typeof userId === 'string' && userId ? userId : undefined;
  } catch {
    return undefined;
  }
}

/** The queue's ARN: it lives in the same account and region as the topic. */
function queueArnFor(topicArn: string, queueName: string): string {
  const [, partition, , region, account] = topicArn.split(':');
  return `arn:${partition}:sqs:${region}:${account}:${queueName}`;
}

/** SQS says the queue is gone (someone deleted it, or another task swept it). */
function isQueueGone(err: unknown): boolean {
  const name = (err as { name?: string })?.name ?? '';
  return name === 'QueueDoesNotExist' || name === 'AWS.SimpleQueueService.NonExistentQueue';
}

function errorText(err: unknown): string {
  return err instanceof Error ? `${err.name}: ${err.message}` : String(err);
}
