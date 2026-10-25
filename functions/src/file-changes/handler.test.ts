import type { SNSClient } from '@aws-sdk/client-sns';
import type { DynamoDBStreamEvent } from 'aws-lambda';
import { changedUsers, handleChanges, snsPublisher } from './handler';

type Rec = { pk: string; newOwner?: string; oldOwner?: string };
const event = (...recs: Rec[]) =>
  ({
    Records: recs.map((r) => ({
      eventName: r.newOwner ? 'MODIFY' : 'REMOVE',
      dynamodb: {
        Keys: { pk: { S: r.pk } },
        ...(r.newOwner ? { NewImage: { pk: { S: r.pk }, gsiUser: { S: r.newOwner } } } : {}),
        ...(r.oldOwner ? { OldImage: { pk: { S: r.pk }, gsiUser: { S: r.oldOwner } } } : {}),
      },
    })),
  }) as unknown as DynamoDBStreamEvent;

describe('changedUsers', () => {
  it('names each owner once, however many of their files changed', () => {
    expect(changedUsers(event({ pk: 'FILE#1', newOwner: 'alice' }, { pk: 'FILE#2', newOwner: 'alice' }, { pk: 'FILE#3', newOwner: 'bob' }))).toEqual([
      'alice',
      'bob',
    ]);
  });

  it("finds a deleted file's owner in the old image", () => {
    expect(changedUsers(event({ pk: 'FILE#1', oldOwner: 'alice' }))).toEqual(['alice']);
  });

  it('ignores the processing ledger and anything that is not a file record', () => {
    expect(changedUsers(event({ pk: 'PROC#uploads/alice/x#v1', newOwner: 'alice' }, { pk: 'SOMETHING', newOwner: 'bob' }))).toEqual([]);
  });

  it('skips a record that names no owner instead of failing the batch', () => {
    const ev = { Records: [{ dynamodb: { Keys: { pk: { S: 'FILE#1' } } } }, { dynamodb: undefined }] } as unknown as DynamoDBStreamEvent;
    expect(changedUsers(ev)).toEqual([]);
  });
});

describe('handleChanges', () => {
  it('publishes the owners once and reports how many', async () => {
    const published: string[][] = [];
    const out = await handleChanges(event({ pk: 'FILE#1', newOwner: 'alice' }, { pk: 'FILE#2', newOwner: 'alice' }), async (u) => void published.push(u));
    expect(published).toEqual([['alice']]);
    expect(out).toEqual({ users: 1 });
  });

  it('publishes nothing when no file changed', async () => {
    const publish = jest.fn();
    await handleChanges(event({ pk: 'PROC#x', newOwner: 'alice' }), publish);
    expect(publish).not.toHaveBeenCalled();
  });
});

describe('snsPublisher', () => {
  const fakeSns = (failures: { Code: string }[] = []) => {
    const calls: {
      TopicArn?: string;
      PublishBatchRequestEntries?: { Id?: string; Message?: string; MessageAttributes?: Record<string, { StringValue?: string }> }[];
    }[] = [];
    const client = { send: async (cmd: { input: (typeof calls)[number] }) => (calls.push(cmd.input), { Failed: failures }) } as unknown as Pick<
      SNSClient,
      'send'
    >;
    return { client, calls };
  };

  it('sends only the user id, as the body and as a message attribute, with distinct entry ids', async () => {
    const { client, calls } = fakeSns();
    await snsPublisher(client, 'arn:aws:sns:us-east-1:1:topic')(['alice', 'bob']);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.TopicArn).toBe('arn:aws:sns:us-east-1:1:topic');
    const entries = calls[0]!.PublishBatchRequestEntries!;
    expect(entries.map((e) => e.Id)).toEqual(['0', '1']);
    expect(entries.map((e) => JSON.parse(e.Message!))).toEqual([{ userId: 'alice' }, { userId: 'bob' }]);
    expect(entries.map((e) => e.MessageAttributes!.userId!.StringValue)).toEqual(['alice', 'bob']);
  });

  it('splits more than ten users across calls, since SNS takes ten per batch', async () => {
    const { client, calls } = fakeSns();
    await snsPublisher(client, 't')(Array.from({ length: 23 }, (_, i) => `u${i}`));
    expect(calls.map((c) => c.PublishBatchRequestEntries!.length)).toEqual([10, 10, 3]);
  });

  it('fails the invocation when SNS reports a rejected message, so the batch is retried', async () => {
    const { client } = fakeSns([{ Code: 'InternalError' }]);
    await expect(snsPublisher(client, 't')(['alice'])).rejects.toThrow(/rejected 1 of 1.*InternalError/);
  });
});
