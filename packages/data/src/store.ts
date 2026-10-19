import type { ProcessingResult } from '@s3up/core';
import type { FileRecord } from './records';

/**
 * Status only ever moves forward:
 *   uploading -> uploaded -> processing -> ready | failed      (failed -> processing on retry)
 *   uploading -> aborted
 *   anything but aborted -> quarantined                         (final)
 * Implementations enforce this atomically, so the API and the worker can race safely
 * (S3's event can reach the worker before the API has acknowledged the upload).
 */
export interface ListOptions {
  /** Page size (1 to 1000, default 100). */
  limit?: number;
  /** `nextCursor` of the previous page. Throws InvalidCursorError if it is malformed. */
  cursor?: string;
  /** Leave out aborted uploads. Pages are still filled, so a page is short only at the end. */
  excludeAborted?: boolean;
}

export interface RecordPage {
  items: FileRecord[];
  /** Pass back as `cursor` for the next page. Absent when there are no more records. */
  nextCursor?: string;
}

/** What a user currently holds, for enforcing quotas. */
export interface UsageTotals {
  /** Uploads still in progress. */
  activeUploads: number;
  /** Declared bytes of every record that still holds storage: in progress, uploaded, processing, ready or failed (not aborted or quarantined). */
  storedBytes: number;
}

export interface FileStore {
  create(record: FileRecord): Promise<void>;
  get(fileId: string): Promise<FileRecord | undefined>;
  /** Totals across all of the user's records (aborted uploads hold nothing). Reads the whole list, so call it sparingly. */
  usage(userId: string): Promise<UsageTotals>;
  /** One page of the user's files, newest first. */
  listByUser(userId: string, options?: ListOptions): Promise<RecordPage>;
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
  /**
   * Any status but aborted -> quarantined, which is final: records why (as the error), drops the
   * processing result, and no later transition applies. Repeating it is fine. Returns false for an
   * unknown or aborted file.
   */
  markQuarantined(fileId: string, reason: string, at: string): Promise<boolean>;
  /** Deletes the record, but only while it is ready, failed or quarantined (finished, with no worker holding it). */
  remove(fileId: string): Promise<boolean>;
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
