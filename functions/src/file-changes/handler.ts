import { PublishBatchCommand, SNSClient } from '@aws-sdk/client-sns';
import type { DynamoDBStreamEvent } from 'aws-lambda';

/** SNS accepts at most this many messages in one PublishBatch call. */
const BATCH = 10;
const FILE_KEY_PREFIX = 'FILE#';

/**
 * Who owns the files that changed in a batch of stream records, each once. The processing ledger lives in the same
 * table and changes constantly, but it is not a file and has no owner, so it is skipped (the event source also
 * filters it out before invoking us; this keeps the function right on its own).
 */
export function changedUsers(event: DynamoDBStreamEvent): string[] {
  const users = new Set<string>();
  for (const record of event.Records) {
    const { Keys, NewImage, OldImage } = record.dynamodb ?? {};
    if (!Keys?.pk?.S?.startsWith(FILE_KEY_PREFIX)) continue;
    // A deleted file has no new image; its owner is in the old one.
    const owner = (NewImage ?? OldImage)?.gsiUser?.S;
    if (owner) users.add(owner);
  }
  return [...users];
}

export type Publish = (userIds: string[]) => Promise<void>;

export async function handleChanges(event: DynamoDBStreamEvent, publish: Publish): Promise<{ users: number }> {
  const users = changedUsers(event);
  if (users.length > 0) await publish(users);
  return { users: users.length };
}

/**
 * Tells every API task that a user's files changed. The message carries only the user id, never file details: a task
 * reads the current list itself, so a dropped or repeated message cannot leave anyone with wrong data.
 */
export function snsPublisher(client: Pick<SNSClient, 'send'>, topicArn: string): Publish {
  return async (userIds) => {
    for (let i = 0; i < userIds.length; i += BATCH) {
      const chunk = userIds.slice(i, i + BATCH);
      const res = await client.send(
        new PublishBatchCommand({
          TopicArn: topicArn,
          PublishBatchRequestEntries: chunk.map((userId, n) => ({
            Id: String(n),
            Message: JSON.stringify({ userId }),
            MessageAttributes: { userId: { DataType: 'String', StringValue: userId } },
          })),
        }),
      );
      // PublishBatch reports per-message failures in the response rather than by throwing.
      if (res.Failed?.length) throw new Error(`SNS rejected ${res.Failed.length} of ${chunk.length} notifications: ${res.Failed[0]?.Code}`);
    }
  };
}

let publisher: Publish | undefined;

export const handler = (event: DynamoDBStreamEvent): Promise<{ users: number }> => {
  const topicArn = process.env.TOPIC_ARN;
  if (!topicArn) throw new Error('Missing environment variable TOPIC_ARN');
  publisher ??= snsPublisher(new SNSClient({}), topicArn);
  return handleChanges(event, publisher);
};
