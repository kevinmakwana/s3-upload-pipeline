import { createHash } from 'node:crypto';
import type { Readable } from 'node:stream';
import { buildThumbnailKey, parseObjectKey, type ProcessingResult } from '@s3up/core';
import type { FileRecord, FileStore, ProcessingLedger } from '@s3up/data';
import { matchesDeclaredType, sniffType } from './sniff';
import { THUMBNAILABLE, makeThumbnail } from './thumbnail';

/** Everything the worker needs from S3, so tests can fake it. */
export interface ObjectStorage {
  head(key: string, versionId?: string): Promise<{ size: number; etag?: string }>;
  /** First `length` bytes, for content sniffing. */
  readHead(key: string, versionId: string | undefined, length: number): Promise<Uint8Array>;
  /** Streams the whole object (never buffers it). */
  stream(key: string, versionId?: string): Promise<Readable>;
  readAll(key: string, versionId?: string): Promise<Buffer>;
  putThumbnail(key: string, body: Buffer): Promise<void>;
}

export interface ProcessorConfig {
  /** Largest image we will decode in memory for a thumbnail. */
  thumbnailMaxBytes: number;
  /** Lease held in the ledger; must exceed the function timeout. */
  leaseMs: number;
  /** Redrive threshold of the queue: the attempt after which a failure is final. */
  maxReceiveCount: number;
}

export interface ProcessorDeps {
  files: FileStore;
  ledger: ProcessingLedger;
  storage: ObjectStorage;
  config: ProcessorConfig;
  now?: () => Date;
  log?: (message: string, fields?: Record<string, unknown>) => void;
}

export interface ObjectRef {
  key: string;
  versionId?: string;
  etag?: string;
}

export type ProcessOutcome =
  { type: 'processed'; result: ProcessingResult } | { type: 'rejected'; reason: string } | { type: 'duplicate' } | { type: 'ignored'; reason: string };

/** Another invocation is working on this object right now; retry later. */
export class ProcessingInProgressError extends Error {
  constructor(key: string) {
    super(`Object ${key} is already being processed`);
    this.name = 'ProcessingInProgressError';
  }
}

/** The file can never be processed successfully (wrong content, wrong size). Not retried. */
class RejectedError extends Error {}

/** Idempotency key: object key + version (or ETag for unversioned buckets). */
export function idempotencyKey(ref: ObjectRef): string {
  return `${ref.key}#${ref.versionId ?? ref.etag ?? 'unversioned'}`;
}

export async function processObject(deps: ProcessorDeps, ref: ObjectRef, receiveCount = 1): Promise<ProcessOutcome> {
  const now = deps.now ?? (() => new Date());
  const log = deps.log ?? (() => undefined);
  const { files, ledger, config } = deps;

  const parsed = parseObjectKey(ref.key);
  if (!parsed) return { type: 'ignored', reason: 'key outside uploads layout' };

  const file = await files.get(parsed.fileId);
  if (!file || file.userId !== parsed.userId || file.s3Key !== ref.key) {
    log('no matching file record', { key: ref.key });
    return { type: 'ignored', reason: 'no matching file record' };
  }
  if (file.status === 'aborted') return { type: 'ignored', reason: 'upload was aborted' };
  if (file.status === 'quarantined') return { type: 'ignored', reason: 'file was quarantined' };

  const idemKey = idempotencyKey(ref);
  const lease = await ledger.begin(idemKey, now(), config.leaseMs);
  if (lease.outcome === 'completed') {
    log('duplicate delivery skipped', { key: ref.key, idemKey });
    return { type: 'duplicate' };
  }
  if (lease.outcome === 'in-progress') throw new ProcessingInProgressError(ref.key);

  await files.markProcessing(file.id, now().toISOString());
  try {
    const result = await analyse(deps, file, ref);
    await files.markReady(file.id, result, now().toISOString());
    await ledger.complete(idemKey, now());
    log('processed', { key: ref.key, sha256: result.sha256 });
    return { type: 'processed', result };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (err instanceof RejectedError) {
      await files.markFailed(file.id, message, now().toISOString());
      await ledger.complete(idemKey, now()); // a verdict, not a crash: don't redo it on duplicates
      log('rejected', { key: ref.key, reason: message });
      return { type: 'rejected', reason: message };
    }
    await ledger.fail(idemKey, message, now());
    if (receiveCount >= config.maxReceiveCount) {
      await files.markFailed(file.id, `Processing failed after ${receiveCount} attempts: ${message}`, now().toISOString());
    }
    throw err; // let SQS retry, then dead-letter
  }
}

async function analyse(deps: ProcessorDeps, file: FileRecord, ref: ObjectRef): Promise<ProcessingResult> {
  const { storage, config } = deps;

  const head = await storage.head(ref.key, ref.versionId);
  if (head.size !== file.size) {
    throw new RejectedError(`Stored object is ${head.size} bytes but ${file.size} were declared`);
  }

  const magic = await storage.readHead(ref.key, ref.versionId, 512);
  const detectedType = sniffType(magic);
  if (!matchesDeclaredType(file.contentType, detectedType)) {
    throw new RejectedError(`Content looks like ${detectedType} but was declared as ${file.contentType}`);
  }

  const sha256 = await hashStream(await storage.stream(ref.key, ref.versionId));
  const result: ProcessingResult = { sha256, size: head.size, ...(detectedType ? { detectedType } : {}) };

  if (!THUMBNAILABLE.has(file.contentType)) {
    result.thumbnailSkipped = file.contentType.startsWith('image/') ? 'format not supported' : 'not an image';
    return result;
  }
  if (head.size > config.thumbnailMaxBytes) {
    result.thumbnailSkipped = `image larger than ${config.thumbnailMaxBytes} bytes`;
    return result;
  }
  try {
    const thumb = await makeThumbnail(await storage.readAll(ref.key, ref.versionId));
    const thumbnailKey = buildThumbnailKey(file.userId, file.id);
    await storage.putThumbnail(thumbnailKey, thumb.jpeg);
    return { ...result, width: thumb.width, height: thumb.height, thumbnailKey };
  } catch (err) {
    // A corrupt image shouldn't fail an otherwise good upload; record why there's no thumbnail.
    result.thumbnailSkipped = `could not decode image: ${err instanceof Error ? err.message : String(err)}`;
    return result;
  }
}

async function hashStream(stream: Readable): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of stream) hash.update(chunk as Buffer);
  return hash.digest('hex');
}
