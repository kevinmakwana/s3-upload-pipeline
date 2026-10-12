import type { ProcessingResult } from '@s3up/core';
import type { FileRecord } from './records';

/**
 * Status only ever moves forward:
 *   uploading -> uploaded -> processing -> ready | failed      (failed -> processing on retry)
 *   uploading -> aborted
 * Implementations enforce this atomically, so the API and the worker can race safely
 * (S3's event can reach the worker before the API has acknowledged the upload).
 */
export interface FileStore {
  create(record: FileRecord): Promise<void>;
  get(fileId: string): Promise<FileRecord | undefined>;
  /** Newest first. */
  listByUser(userId: string, limit?: number): Promise<FileRecord[]>;
  /** uploading -> uploaded. If the worker already moved on, only the metadata is recorded. */
  markUploaded(fileId: string, info: { etag?: string; versionId?: string; at: string }): Promise<FileRecord | undefined>;
  /** uploading -> aborted. Returns false if it was no longer uploading. */
  markAborted(fileId: string, at: string): Promise<boolean>;
  /** uploading|uploaded|processing|failed -> processing. */
  markProcessing(fileId: string, at: string): Promise<boolean>;
  /** uploading|uploaded|processing -> ready. */
  markReady(fileId: string, result: ProcessingResult, at: string): Promise<boolean>;
  /** uploading|uploaded|processing|failed -> failed. Never overwrites ready or aborted. */
  markFailed(fileId: string, error: string, at: string): Promise<boolean>;
}

export type LedgerOutcome =
  | { outcome: 'acquired'; attempts: number }
  /** Already processed successfully: skip. */
  | { outcome: 'completed' }
  /** Another invocation holds a live lease: retry later. */
  | { outcome: 'in-progress' };

/**
 * Idempotency ledger keyed by `<object key>#<version>`. `begin` takes a lease so a
 * duplicate S3/SQS delivery can't process the same object concurrently, while a
 * crashed worker's lease simply expires.
 */
export interface ProcessingLedger {
  begin(idempotencyKey: string, now: Date, leaseMs: number): Promise<LedgerOutcome>;
  complete(idempotencyKey: string, now: Date): Promise<void>;
  fail(idempotencyKey: string, error: string, now: Date): Promise<void>;
}
