import type { ProcessingResult } from '@s3up/core';
import type { FileRecord } from './records';
import { clampLimit, decodeCursor, encodeCursor } from './cursor';
import type { FileStore, LedgerOutcome, ListOptions, ProcessingLedger, RecordPage } from './store';

/** In-memory twin of the DynamoDB implementations; the same contract tests run against both. */
export class MemoryFileStore implements FileStore {
  readonly records = new Map<string, FileRecord>();

  async create(record: FileRecord) {
    if (this.records.has(record.id)) throw new Error('already exists');
    this.records.set(record.id, structuredClone(record));
  }
  async get(fileId: string) {
    const r = this.records.get(fileId);
    return r && structuredClone(r);
  }
  async listByUser(userId: string, options: ListOptions = {}): Promise<RecordPage> {
    const limit = clampLimit(options.limit);
    const position = options.cursor === undefined ? undefined : decodeCursor(options.cursor);
    // Newest first; id breaks ties so equal timestamps still have one stable order.
    // Plain code-unit comparison, not localeCompare: it must agree with the `<` used for the cursor.
    const desc = (a: string, b: string) => (a < b ? 1 : a > b ? -1 : 0);
    const newestFirst = (a: FileRecord, b: FileRecord) => desc(a.createdAt, b.createdAt) || desc(a.id, b.id);
    const after = (r: FileRecord) =>
      !position || r.createdAt < position.createdAt || (r.createdAt === position.createdAt && r.id < position.id);
    const matching = [...this.records.values()]
      .filter((r) => r.userId === userId && (!options.excludeAborted || r.status !== 'aborted') && after(r))
      .sort(newestFirst);
    const items = matching.slice(0, limit).map((r) => structuredClone(r));
    const last = items.at(-1);
    return { items, ...(matching.length > limit && last ? { nextCursor: encodeCursor(last) } : {}) };
  }
  async markUploaded(fileId: string, info: { etag?: string; versionId?: string; at: string }) {
    const r = this.records.get(fileId);
    if (!r || r.status === 'aborted') return undefined;
    if (r.status === 'uploading') r.status = 'uploaded';
    r.etag = info.etag ?? r.etag;
    r.versionId = info.versionId ?? r.versionId;
    r.uploadedAt ??= info.at;
    r.updatedAt = info.at;
    delete r.expiresAt;
    return structuredClone(r);
  }
  async remove(fileId: string) {
    const r = this.records.get(fileId);
    if (!r || (r.status !== 'ready' && r.status !== 'failed')) return false;
    return this.records.delete(fileId);
  }
  async markAborted(fileId: string, at: string) {
    return this.move(fileId, ['uploading'], 'aborted', at);
  }
  async markProcessing(fileId: string, at: string) {
    const r = this.records.get(fileId);
    const ok = this.move(fileId, ['uploading', 'uploaded', 'processing', 'failed'], 'processing', at);
    if (r && (await ok)) delete r.error;
    return ok;
  }
  async markReady(fileId: string, result: ProcessingResult, at: string) {
    const ok = await this.move(fileId, ['uploading', 'uploaded', 'processing'], 'ready', at);
    if (ok) {
      const r = this.records.get(fileId)!;
      r.result = result;
      r.processedAt = at;
      delete r.error;
      delete r.expiresAt;
    }
    return ok;
  }
  async markFailed(fileId: string, error: string, at: string) {
    const ok = await this.move(fileId, ['uploading', 'uploaded', 'processing', 'failed'], 'failed', at);
    if (ok) {
      const r = this.records.get(fileId)!;
      r.error = error.slice(0, 1000);
      r.processedAt = at;
      delete r.expiresAt;
    }
    return ok;
  }
  private async move(fileId: string, from: string[], to: FileRecord['status'], at: string) {
    const r = this.records.get(fileId);
    if (!r || !from.includes(r.status)) return false;
    r.status = to;
    r.updatedAt = at;
    return true;
  }
}

interface LedgerEntry {
  status: 'in-progress' | 'completed' | 'failed';
  leaseUntil?: number;
  attempts: number;
  error?: string;
}

export class MemoryLedger implements ProcessingLedger {
  readonly entries = new Map<string, LedgerEntry>();

  async begin(key: string, now: Date, leaseMs: number): Promise<LedgerOutcome> {
    const e = this.entries.get(key);
    const nowMs = now.getTime();
    if (e?.status === 'completed') return { outcome: 'completed' };
    if (e?.status === 'in-progress' && (e.leaseUntil ?? 0) >= nowMs) return { outcome: 'in-progress' };
    const attempts = (e?.attempts ?? 0) + 1;
    this.entries.set(key, { status: 'in-progress', leaseUntil: nowMs + leaseMs, attempts });
    return { outcome: 'acquired', attempts };
  }
  async complete(key: string) {
    const e = this.entries.get(key);
    if (e?.status === 'in-progress') this.entries.set(key, { ...e, status: 'completed', leaseUntil: undefined });
  }
  async fail(key: string, error: string) {
    const e = this.entries.get(key);
    if (e?.status === 'in-progress') this.entries.set(key, { ...e, status: 'failed', error, leaseUntil: undefined });
  }
}
