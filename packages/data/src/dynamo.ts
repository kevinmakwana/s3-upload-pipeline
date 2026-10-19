import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { DeleteCommand, GetCommand, PutCommand, QueryCommand, UpdateCommand, type DynamoDBDocumentClient, type QueryCommandOutput } from '@aws-sdk/lib-dynamodb';
import type { ProcessingResult } from '@s3up/core';
import type { FileRecord } from './records';
import { clampLimit, decodeCursor, encodeCursor } from './cursor';
import type { FileStore, LedgerOutcome, ListOptions, ProcessingLedger, RecordPage, UsageTotals } from './store';

export const USER_INDEX = 'byUser';
const fileKey = (id: string) => `FILE#${id}`;
const ledgerKey = (key: string) => `PROC#${key}`;
const LEDGER_TTL_SECONDS = 30 * 24 * 3600;

/** Fields stored alongside `pk`; `gsiUser`/`gsiCreated` feed the by-user index. */
type Item = FileRecord & { pk: string; gsiUser: string; gsiCreated: string };

async function conditional<T>(op: () => Promise<T>): Promise<T | undefined> {
  try {
    return await op();
  } catch (err) {
    if (err instanceof ConditionalCheckFailedException) return undefined;
    throw err;
  }
}

function toRecord(item: Record<string, unknown>): FileRecord {
  const { pk: _pk, gsiUser: _u, gsiCreated: _c, ...record } = item;
  return record as unknown as FileRecord;
}

export class DynamoFileStore implements FileStore {
  constructor(
    private readonly doc: DynamoDBDocumentClient,
    private readonly tableName: string,
  ) {}

  async create(record: FileRecord): Promise<void> {
    const item: Item = { ...record, pk: fileKey(record.id), gsiUser: record.userId, gsiCreated: record.createdAt };
    await this.doc.send(new PutCommand({ TableName: this.tableName, Item: item, ConditionExpression: 'attribute_not_exists(pk)' }));
  }

  async get(fileId: string): Promise<FileRecord | undefined> {
    const res = await this.doc.send(new GetCommand({ TableName: this.tableName, Key: { pk: fileKey(fileId) }, ConsistentRead: true }));
    return res.Item ? toRecord(res.Item) : undefined;
  }

  async usage(userId: string): Promise<UsageTotals> {
    let activeUploads = 0;
    let storedBytes = 0;
    let startKey: Record<string, unknown> | undefined;
    do {
      const res: QueryCommandOutput = await this.doc.send(
        new QueryCommand({
          TableName: this.tableName,
          IndexName: USER_INDEX,
          KeyConditionExpression: 'gsiUser = :u',
          ExpressionAttributeValues: { ':u': userId },
          // "status" and "size" are reserved words; project only what is summed.
          ProjectionExpression: '#status, #size',
          ExpressionAttributeNames: { '#status': 'status', '#size': 'size' },
          ExclusiveStartKey: startKey,
        }),
      );
      for (const item of res.Items ?? []) {
        if (item.status === 'aborted' || item.status === 'quarantined') continue;
        storedBytes += Number(item.size) || 0;
        if (item.status === 'uploading') activeUploads++;
      }
      startKey = res.LastEvaluatedKey;
    } while (startKey);
    return { activeUploads, storedBytes };
  }

  async listByUser(userId: string, options: ListOptions = {}): Promise<RecordPage> {
    const limit = clampLimit(options.limit);
    // Rebuilt from the caller's own user id, never taken from the cursor.
    const position = options.cursor === undefined ? undefined : decodeCursor(options.cursor);
    let startKey: Record<string, unknown> | undefined = position && {
      pk: fileKey(position.id),
      gsiUser: userId,
      gsiCreated: position.createdAt,
    };

    // Ask for one more record than the page holds: if it shows up there is a next page, so the
    // last page never needs an empty follow-up. A filter runs after DynamoDB's Limit, so keep
    // querying until the page is full, asking only for what is still missing.
    const wanted = limit + 1;
    const found: FileRecord[] = [];
    do {
      const res: QueryCommandOutput = await this.doc.send(
        new QueryCommand({
          TableName: this.tableName,
          IndexName: USER_INDEX,
          KeyConditionExpression: 'gsiUser = :u',
          ...(options.excludeAborted ? { FilterExpression: '#status <> :aborted', ExpressionAttributeNames: { '#status': 'status' } } : {}),
          ExpressionAttributeValues: { ':u': userId, ...(options.excludeAborted ? { ':aborted': 'aborted' } : {}) },
          ScanIndexForward: false,
          Limit: wanted - found.length,
          ExclusiveStartKey: startKey,
        }),
      );
      found.push(...(res.Items ?? []).map(toRecord));
      startKey = res.LastEvaluatedKey;
    } while (startKey && found.length < wanted);

    const items = found.slice(0, limit);
    const last = items.at(-1);
    return { items, ...(found.length > limit && last ? { nextCursor: encodeCursor(last) } : {}) };
  }

  async markUploaded(fileId: string, info: { etag?: string; versionId?: string; at: string }): Promise<FileRecord | undefined> {
    const meta: string[] = [];
    const values: Record<string, unknown> = { ':at': info.at };
    if (info.etag) {
      meta.push('etag = :etag');
      values[':etag'] = info.etag;
    }
    if (info.versionId) {
      meta.push('versionId = :ver');
      values[':ver'] = info.versionId;
    }
    const metaSet = meta.length ? `, ${meta.join(', ')}` : '';
    const advanced = await conditional(() =>
      this.update(fileId, {
        UpdateExpression: `SET #s = :up, uploadedAt = :at, updatedAt = :at${metaSet} REMOVE expiresAt`,
        ConditionExpression: '#s = :uploading',
        ExpressionAttributeNames: { '#s': 'status' },
        ExpressionAttributeValues: { ...values, ':up': 'uploaded', ':uploading': 'uploading' },
      }),
    );
    if (advanced) return advanced;
    // The worker got there first (or it was already marked). Record metadata without touching status.
    return conditional(() =>
      this.update(fileId, {
        UpdateExpression: `SET uploadedAt = if_not_exists(uploadedAt, :at), updatedAt = :at${metaSet} REMOVE expiresAt`,
        ConditionExpression: 'attribute_exists(pk) AND #s <> :aborted',
        ExpressionAttributeNames: { '#s': 'status' },
        ExpressionAttributeValues: { ...values, ':aborted': 'aborted' },
      }),
    );
  }

  async remove(fileId: string): Promise<boolean> {
    const res = await conditional(() =>
      this.doc.send(
        new DeleteCommand({
          TableName: this.tableName,
          Key: { pk: fileKey(fileId) },
          ConditionExpression: '#s IN (:ready, :failed, :quarantined)',
          ExpressionAttributeNames: { '#s': 'status' },
          ExpressionAttributeValues: { ':ready': 'ready', ':failed': 'failed', ':quarantined': 'quarantined' },
        }),
      ),
    );
    return res !== undefined;
  }

  async markAborted(fileId: string, at: string): Promise<boolean> {
    return this.transition(fileId, ['uploading'], 'aborted', 'SET updatedAt = :at', { ':at': at });
  }

  markProcessing(fileId: string, at: string): Promise<boolean> {
    return this.transition(fileId, ['uploading', 'uploaded', 'processing', 'failed'], 'processing', 'SET updatedAt = :at REMOVE #err', { ':at': at });
  }

  markReady(fileId: string, result: ProcessingResult, at: string): Promise<boolean> {
    return this.transition(
      fileId,
      ['uploading', 'uploaded', 'processing'],
      'ready',
      'SET updatedAt = :at, processedAt = :at, #result = :result REMOVE #err, expiresAt',
      { ':at': at, ':result': result },
      { '#result': 'result' },
    );
  }

  markFailed(fileId: string, error: string, at: string): Promise<boolean> {
    return this.transition(
      fileId,
      ['uploading', 'uploaded', 'processing', 'failed'],
      'failed',
      'SET updatedAt = :at, processedAt = :at, #err = :error REMOVE expiresAt',
      { ':at': at, ':error': error.slice(0, 1000) },
    );
  }

  markQuarantined(fileId: string, reason: string, at: string): Promise<boolean> {
    return this.transition(
      fileId,
      ['uploading', 'uploaded', 'processing', 'ready', 'failed', 'quarantined'],
      'quarantined',
      'SET updatedAt = :at, processedAt = :at, #err = :error REMOVE #result, expiresAt',
      { ':at': at, ':error': reason.slice(0, 1000) },
      { '#result': 'result' },
    );
  }

  private async transition(
    fileId: string,
    from: string[],
    to: string,
    setClause: string,
    values: Record<string, unknown>,
    extraNames: Record<string, string> = {},
  ): Promise<boolean> {
    const fromValues = Object.fromEntries(from.map((s, i) => [`:from${i}`, s]));
    const res = await conditional(() =>
      this.update(fileId, {
        UpdateExpression: `${setClause.replace(/^SET /, 'SET #s = :to, ')}`,
        ConditionExpression: `#s IN (${Object.keys(fromValues).join(', ')})`,
        ExpressionAttributeNames: { '#s': 'status', '#err': 'error', ...extraNames },
        ExpressionAttributeValues: { ':to': to, ...fromValues, ...values },
      }),
    );
    return res !== undefined;
  }

  private async update(
    fileId: string,
    params: { UpdateExpression: string; ConditionExpression: string; ExpressionAttributeNames: Record<string, string>; ExpressionAttributeValues: Record<string, unknown> },
  ): Promise<FileRecord> {
    const names = pruneNames(params);
    const res = await this.doc.send(
      new UpdateCommand({
        TableName: this.tableName,
        Key: { pk: fileKey(fileId) },
        ...params,
        ExpressionAttributeNames: names,
        ReturnValues: 'ALL_NEW',
      }),
    );
    return toRecord(res.Attributes!);
  }
}

/** DynamoDB rejects unused expression attribute names; keep only those referenced. */
function pruneNames(params: { UpdateExpression: string; ConditionExpression: string; ExpressionAttributeNames: Record<string, string> }) {
  const text = `${params.UpdateExpression} ${params.ConditionExpression}`;
  return Object.fromEntries(Object.entries(params.ExpressionAttributeNames).filter(([k]) => text.includes(k)));
}

export class DynamoProcessingLedger implements ProcessingLedger {
  constructor(
    private readonly doc: DynamoDBDocumentClient,
    private readonly tableName: string,
  ) {}

  async begin(idempotencyKey: string, now: Date, leaseMs: number): Promise<LedgerOutcome> {
    const nowMs = now.getTime();
    const key = { pk: ledgerKey(idempotencyKey) };
    const res = await conditional(() =>
      this.doc.send(
        new UpdateCommand({
          TableName: this.tableName,
          Key: key,
          UpdateExpression: 'SET #s = :inprog, leaseUntil = :until, startedAt = :now, expiresAt = :ttl ADD attempts :one',
          ConditionExpression: 'attribute_not_exists(pk) OR #s = :failed OR (#s = :inprog AND leaseUntil < :nowMs)',
          ExpressionAttributeNames: { '#s': 'status' },
          ExpressionAttributeValues: {
            ':inprog': 'in-progress',
            ':failed': 'failed',
            ':until': nowMs + leaseMs,
            ':nowMs': nowMs,
            ':now': now.toISOString(),
            ':ttl': Math.floor(nowMs / 1000) + LEDGER_TTL_SECONDS,
            ':one': 1,
          },
          ReturnValues: 'ALL_NEW',
        }),
      ),
    );
    if (res?.Attributes) return { outcome: 'acquired', attempts: Number(res.Attributes.attempts ?? 1) };

    const existing = await this.doc.send(new GetCommand({ TableName: this.tableName, Key: key, ConsistentRead: true }));
    return existing.Item?.status === 'completed' ? { outcome: 'completed' } : { outcome: 'in-progress' };
  }

  async complete(idempotencyKey: string, now: Date): Promise<void> {
    await this.finish(idempotencyKey, 'completed', now);
  }

  async fail(idempotencyKey: string, error: string, now: Date): Promise<void> {
    await this.finish(idempotencyKey, 'failed', now, error.slice(0, 1000));
  }

  private async finish(idempotencyKey: string, status: 'completed' | 'failed', now: Date, error?: string) {
    await conditional(() =>
      this.doc.send(
        new UpdateCommand({
          TableName: this.tableName,
          Key: { pk: ledgerKey(idempotencyKey) },
          UpdateExpression: `SET #s = :status, finishedAt = :now${error ? ', #err = :err' : ''} REMOVE leaseUntil`,
          ConditionExpression: '#s = :inprog',
          ExpressionAttributeNames: { '#s': 'status', ...(error ? { '#err': 'error' } : {}) },
          ExpressionAttributeValues: { ':status': status, ':now': now.toISOString(), ':inprog': 'in-progress', ...(error ? { ':err': error } : {}) },
        }),
      ),
    );
  }
}
