import { sha256Base64 } from './checksum';
import { FileChangedError, HttpError, UploadGoneError, isAbortError, isRetryable } from './errors';
import { PartPlan, partRange } from './planning';
import { LocalPart, reconcileParts } from './reconcile';
import type { FileDto, InitUploadRequest, ListPartsResponse, PresignPartResponse } from './types';

/** What the engine needs from the backend. All methods are scoped to the current user. */
export interface UploadApi {
  init(req: InitUploadRequest): Promise<FileDto>;
  listParts(fileId: string): Promise<ListPartsResponse>;
  presignPart(fileId: string, partNumber: number, sha256: string): Promise<PresignPartResponse>;
  complete(fileId: string): Promise<FileDto>;
  abort(fileId: string): Promise<void>;
}

/** Where the bytes come from: a browser File, a Node file handle, a test buffer. */
export interface PartSource {
  readonly size: number;
  read(start: number, end: number): Promise<Uint8Array>;
}

export interface PutRequest {
  url: string;
  headers: Record<string, string>;
  body: Uint8Array;
  signal: AbortSignal;
  onProgress(loadedBytes: number): void;
}

/** PUTs one part straight to S3 (XMLHttpRequest in the browser, fetch in Node). */
export interface PartTransport {
  put(req: PutRequest): Promise<void>;
}

/** What survives a page reload. */
export interface PersistedUpload {
  fileId: string;
  fileName: string;
  contentType: string;
  fileSize: number;
  lastModified: number;
  partSize: number;
  partCount: number;
  parts: Record<number, LocalPart>;
  createdAt: string;
  updatedAt: string;
}

export interface ResumeStore {
  get(fileId: string): Promise<PersistedUpload | undefined>;
  put(upload: PersistedUpload): Promise<void>;
  delete(fileId: string): Promise<void>;
}

export class MemoryResumeStore implements ResumeStore {
  readonly items = new Map<string, PersistedUpload>();
  async get(fileId: string) {
    const v = this.items.get(fileId);
    return v && structuredClone(v);
  }
  async put(upload: PersistedUpload) {
    this.items.set(upload.fileId, structuredClone(upload));
  }
  async delete(fileId: string) {
    this.items.delete(fileId);
  }
}

export type UploadPhase = 'idle' | 'preparing' | 'verifying' | 'uploading' | 'completing' | 'done' | 'paused' | 'cancelled' | 'error';

export interface UploadProgress {
  fileId?: string;
  phase: UploadPhase;
  bytesUploaded: number;
  totalBytes: number;
  partsDone: number;
  partCount: number;
  activeParts: number;
  /** Set when a stale session was discarded and the upload started over. */
  restarted?: boolean;
  error?: string;
}

export type UploadOutcome = { type: 'done'; file: FileDto } | { type: 'paused' } | { type: 'cancelled' };

export interface UploadOptions {
  concurrency: number;
  /** Retries per part (so a part is tried up to maxRetries + 1 times). */
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
  sleep(ms: number, signal: AbortSignal): Promise<void>;
  random(): number;
  sha256(data: Uint8Array): Promise<string>;
  now(): Date;
}

export const DEFAULT_CONCURRENCY = 4;

export function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(abortError());
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

export function abortError(): Error {
  const e = new Error('Aborted');
  e.name = 'AbortError';
  return e;
}

/** Full-jitter exponential backoff. */
export function backoffDelay(attempt: number, base: number, max: number, random: () => number): number {
  return Math.floor(random() * Math.min(max, base * 2 ** attempt));
}

export interface FileMeta {
  fileName: string;
  contentType: string;
  lastModified: number;
}

export interface UploadDeps {
  api: UploadApi;
  transport: PartTransport;
  store: ResumeStore;
}

type Intent = 'pause' | 'cancel' | undefined;

/**
 * One resumable multipart upload. The same object can be paused and started
 * again; a new object built from a PersistedUpload resumes after a reload.
 * Completed parts are persisted after every part, and on every (re)start the
 * server's ListParts answer is reconciled with local memory.
 */
export class Upload {
  private readonly options: UploadOptions;
  private fileId?: string;
  private plan?: PartPlan;
  private parts: Record<number, LocalPart> = {};
  private createdAt: string;
  private readonly loaded = new Map<number, number>();
  private phase: UploadPhase = 'idle';
  private error?: string;
  private restarted = false;
  private intent: Intent;
  private controller?: AbortController;
  private running?: Promise<UploadOutcome>;
  private readonly listeners = new Set<(p: UploadProgress) => void>();

  constructor(
    private readonly deps: UploadDeps,
    private readonly source: PartSource,
    private readonly meta: FileMeta,
    options: Partial<UploadOptions> = {},
    persisted?: PersistedUpload,
  ) {
    this.options = {
      concurrency: DEFAULT_CONCURRENCY,
      maxRetries: 5,
      baseDelayMs: 500,
      maxDelayMs: 15_000,
      sleep: abortableSleep,
      random: Math.random,
      sha256: sha256Base64,
      now: () => new Date(),
      ...options,
    };
    this.createdAt = this.options.now().toISOString();
    if (persisted) {
      if (persisted.fileSize !== source.size) throw new FileChangedError('Selected file has a different size');
      this.fileId = persisted.fileId;
      this.plan = { fileSize: persisted.fileSize, partSize: persisted.partSize, partCount: persisted.partCount };
      this.parts = { ...persisted.parts };
      this.createdAt = persisted.createdAt;
    }
  }

  get progress(): UploadProgress {
    let bytes = 0;
    for (const [n, p] of Object.entries(this.parts)) bytes += this.plan ? partRange(this.plan, Number(n)).size : p.size;
    for (const v of this.loaded.values()) bytes += v;
    return {
      fileId: this.fileId,
      phase: this.phase,
      bytesUploaded: Math.min(bytes, this.source.size),
      totalBytes: this.source.size,
      partsDone: Object.keys(this.parts).length,
      partCount: this.plan?.partCount ?? 0,
      activeParts: this.loaded.size,
      restarted: this.restarted || undefined,
      error: this.error,
    };
  }

  /** Per-part state for visualisation: 0 = waiting, 1 = in flight, 2 = uploaded. Index = partNumber - 1. */
  partStates(): Uint8Array {
    const states = new Uint8Array(this.plan?.partCount ?? 0);
    for (const n of Object.keys(this.parts)) states[Number(n) - 1] = 2;
    for (const n of this.loaded.keys()) if (states[n - 1] !== 2) states[n - 1] = 1;
    return states;
  }

  subscribe(fn: (p: UploadProgress) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Runs (or resumes) the upload. Resolves with how it ended; rejects if it failed. */
  start(): Promise<UploadOutcome> {
    if (this.running) return this.running;
    this.intent = undefined;
    this.error = undefined;
    this.controller = new AbortController();
    const signal = this.controller.signal;
    this.running = this.run(signal).finally(() => {
      this.running = undefined;
    });
    return this.running;
  }

  /** Stops in-flight requests; completed parts stay recorded so start() can continue. */
  pause(): void {
    if (!this.running) return;
    this.intent = 'pause';
    this.controller?.abort();
  }

  /** Aborts the multipart upload server-side and forgets local state. */
  async cancel(): Promise<void> {
    this.intent = 'cancel';
    if (this.running) {
      this.controller?.abort();
      await this.running.catch(() => undefined);
      return;
    }
    await this.discard();
  }

  private emit(): void {
    if (this.listeners.size === 0) return;
    const p = this.progress;
    for (const fn of this.listeners) fn(p);
  }

  private setPhase(phase: UploadPhase): void {
    this.phase = phase;
    this.emit();
  }

  private async persist(): Promise<void> {
    if (!this.fileId || !this.plan) return;
    await this.deps.store.put({
      fileId: this.fileId,
      fileName: this.meta.fileName,
      contentType: this.meta.contentType,
      fileSize: this.plan.fileSize,
      lastModified: this.meta.lastModified,
      partSize: this.plan.partSize,
      partCount: this.plan.partCount,
      parts: this.parts,
      createdAt: this.createdAt,
      updatedAt: this.options.now().toISOString(),
    });
  }

  private async discard(): Promise<void> {
    const fileId = this.fileId;
    if (fileId) {
      await this.deps.api.abort(fileId).catch(() => undefined);
      await this.deps.store.delete(fileId);
    }
    this.parts = {};
    this.loaded.clear();
    this.setPhase('cancelled');
  }

  private async run(signal: AbortSignal): Promise<UploadOutcome> {
    try {
      this.setPhase('preparing');
      const finished = await this.prepare(signal);
      if (finished) return this.finish(finished);

      this.setPhase('uploading');
      await this.uploadMissing(signal);

      this.setPhase('completing');
      const file = await this.withRetry(() => this.deps.api.complete(this.fileId!), signal);
      return this.finish(file);
    } catch (err) {
      if (signal.aborted || isAbortError(err)) {
        this.loaded.clear();
        if (this.intent === 'cancel') {
          await this.discard();
          return { type: 'cancelled' };
        }
        this.setPhase('paused');
        return { type: 'paused' };
      }
      this.loaded.clear();
      this.error = err instanceof Error ? err.message : String(err);
      this.setPhase('error');
      throw err;
    }
  }

  private async finish(file: FileDto): Promise<UploadOutcome> {
    if (this.fileId) await this.deps.store.delete(this.fileId);
    this.loaded.clear();
    this.setPhase('done');
    return { type: 'done', file };
  }

  /**
   * Creates the server session (first run) or reconciles with it (resume).
   * Returns the final file if the server says the upload was already completed.
   */
  private async prepare(signal: AbortSignal): Promise<FileDto | undefined> {
    if (!this.fileId || !this.plan) {
      await this.startFresh(signal);
      return undefined;
    }
    try {
      const remote = await this.withRetry(() => this.deps.api.listParts(this.fileId!), signal);
      if (remote.file.status !== 'uploading') {
        if (remote.file.status === 'aborted' || remote.file.status === 'failed') throw new UploadGoneError();
        return remote.file; // already completed elsewhere (e.g. complete succeeded but the reply was lost)
      }
      const plan = this.plan;
      const rec = reconcileParts(plan, remote.parts, this.parts);

      const kept: Record<number, LocalPart> = {};
      for (const n of rec.done)
        kept[n] = this.parts[n] ?? { sha256: remote.parts.find((p) => p.partNumber === n)!.sha256 ?? '', size: partRange(plan, n).size };
      if (rec.verify.length > 0) {
        this.parts = kept;
        this.setPhase('verifying');
        const remoteByNumber = new Map(remote.parts.map((p) => [p.partNumber, p]));
        await runPool(rec.verify, this.options.concurrency, signal, async (n, _signal) => {
          const { start, end, size } = partRange(plan, n);
          const sha = await this.options.sha256(await this.readPart(start, end));
          if (sha === remoteByNumber.get(n)?.sha256) kept[n] = { sha256: sha, size };
        });
        this.setPhase('preparing');
      }
      this.parts = kept;
      await this.persist();
      this.emit();
      return undefined;
    } catch (err) {
      if (err instanceof UploadGoneError) {
        // The multipart upload expired (lifecycle rule) or was aborted: begin again.
        await this.deps.store.delete(this.fileId!);
        this.fileId = undefined;
        this.plan = undefined;
        this.parts = {};
        this.restarted = true;
        await this.startFresh(signal);
        return undefined;
      }
      throw err;
    }
  }

  private async startFresh(signal: AbortSignal): Promise<void> {
    const file = await this.withRetry(
      () => this.deps.api.init({ fileName: this.meta.fileName, fileSize: this.source.size, contentType: this.meta.contentType }),
      signal,
    );
    this.fileId = file.id;
    this.plan = { fileSize: file.size, partSize: file.partSize, partCount: file.partCount };
    this.parts = {};
    this.createdAt = this.options.now().toISOString();
    await this.persist();
    this.emit();
  }

  private async uploadMissing(signal: AbortSignal): Promise<void> {
    const plan = this.plan!;
    const missing: number[] = [];
    for (let n = 1; n <= plan.partCount; n++) if (!this.parts[n]) missing.push(n);
    await runPool(missing, this.options.concurrency, signal, (n, poolSignal) => this.uploadPart(n, poolSignal));
  }

  private async readPart(start: number, end: number): Promise<Uint8Array> {
    const bytes = await this.source.read(start, end);
    if (bytes.byteLength !== end - start) throw new FileChangedError('File is shorter than expected');
    return bytes;
  }

  private async uploadPart(partNumber: number, signal: AbortSignal): Promise<void> {
    const plan = this.plan!;
    const fileId = this.fileId!;
    const { start, end, size } = partRange(plan, partNumber);
    const body = await this.readPart(start, end);
    const sha256 = await this.options.sha256(body);
    if (signal.aborted) throw abortError();

    this.loaded.set(partNumber, 0);
    this.emit();
    try {
      // Each attempt re-presigns, so an expired URL is just another retry.
      await this.withRetry(async () => {
        this.loaded.set(partNumber, 0);
        const presigned = await this.deps.api.presignPart(fileId, partNumber, sha256);
        await this.deps.transport.put({
          url: presigned.url,
          headers: presigned.headers,
          body,
          signal,
          onProgress: (n) => {
            this.loaded.set(partNumber, Math.min(n, size));
            this.emit();
          },
        });
      }, signal);
    } finally {
      this.loaded.delete(partNumber);
    }
    this.parts[partNumber] = { sha256, size };
    await this.persist();
    this.emit();
  }

  private async withRetry<T>(fn: () => Promise<T>, signal: AbortSignal): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await fn();
      } catch (err) {
        if (signal.aborted || isAbortError(err)) throw abortError();
        if (err instanceof HttpError && err.status === 410) throw new UploadGoneError();
        if (!isRetryable(err) || attempt >= this.options.maxRetries) throw err;
        await this.options.sleep(backoffDelay(attempt, this.options.baseDelayMs, this.options.maxDelayMs, this.options.random), signal);
      }
    }
  }
}

/** Runs `fn` over `items` with bounded concurrency; stops early on the first error or abort. */
export async function runPool<T>(
  items: readonly T[],
  concurrency: number,
  signal: AbortSignal,
  fn: (item: T, signal: AbortSignal) => Promise<void>,
): Promise<void> {
  const queue = [...items];
  const inner = new AbortController();
  const onAbort = () => inner.abort();
  signal.addEventListener('abort', onAbort, { once: true });
  let firstError: unknown;
  let failed = false;

  const worker = async () => {
    while (!inner.signal.aborted) {
      const item = queue.shift();
      if (item === undefined) return;
      try {
        await fn(item, inner.signal);
      } catch (err) {
        if (!failed && !(signal.aborted && isAbortError(err))) {
          failed = true;
          firstError = err;
        }
        inner.abort();
        return;
      }
    }
  };

  try {
    await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, queue.length)) }, worker));
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
  if (failed) throw firstError;
  if (signal.aborted) throw abortError();
}
