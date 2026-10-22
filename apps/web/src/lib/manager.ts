import {
  Upload,
  type DownloadUrlResponse,
  type FileDto,
  type FilePage,
  type PartSource,
  type PartTransport,
  type PersistedUpload,
  type ResumeStore,
  type UploadApi,
  type UploadOptions,
  type UploadPhase,
  type UploadProgress,
} from '@s3up/core';
import type { ConnectionState } from './sse';

/** A local upload session: running, paused, failed, or interrupted by a reload. */
export interface LocalUpload {
  localId: string;
  fileId?: string;
  fileName: string;
  contentType: string;
  size: number;
  lastModified: number;
  phase: UploadPhase | 'interrupted';
  bytesUploaded: number;
  partsDone: number;
  partCount: number;
  activeParts: number;
  bytesPerSecond: number;
  etaSeconds?: number;
  /** 0 waiting, 1 in flight, 2 uploaded. */
  partStates: Uint8Array;
  error?: string;
  restarted?: boolean;
  /** Interrupted upload whose file we can reopen with one click (no file picker). */
  canReopenFile: boolean;
}

/** What is happening to a file in the list right now, or why the last attempt failed. */
export interface FileAction {
  busy?: 'download' | 'delete';
  error?: string;
}

export interface ManagerSnapshot {
  local: LocalUpload[];
  files: FileDto[];
  /** Older files exist on the server that have not been loaded yet. */
  hasMoreFiles: boolean;
  loadingMoreFiles: boolean;
  /** Per file id; absent when nothing is going on. */
  fileActions: Record<string, FileAction>;
  connection: ConnectionState;
  concurrency: number;
}

export interface ManagerDeps {
  api: UploadApi & {
    listFilesPage?(options?: { limit?: number; cursor?: string }): Promise<FilePage>;
    getDownloadUrl?(fileId: string): Promise<DownloadUrlResponse>;
    deleteFile?(fileId: string): Promise<void>;
  };
  /** Starts saving the file at this (attachment) URL, for example by clicking a hidden link. */
  startDownload?: (url: string) => void;
  transport: PartTransport;
  store: ResumeStore & {
    list(): Promise<PersistedUpload[]>;
    putHandle?(fileId: string, handle: FileSystemFileHandle): Promise<void>;
    getHandle?(fileId: string): Promise<FileSystemFileHandle | undefined>;
  };
  makeSource(file: File): PartSource;
  uploadOptions?: Partial<UploadOptions>;
  concurrency?: number;
  now?: () => number;
  storage?: Pick<Storage, 'getItem' | 'setItem'>;
}

interface Entry {
  view: LocalUpload;
  upload?: Upload;
  file?: File;
  handle?: FileSystemFileHandle;
  persisted?: PersistedUpload;
  samples: Array<{ t: number; bytes: number }>;
}

const SPEED_WINDOW_MS = 6000;
export const CONCURRENCY_KEY = 's3up:concurrency';

/**
 * Owns every upload in this tab. The UI only reads snapshots and calls actions, which keeps the
 * interesting behaviour (resume after reload, one-click reopen, speed/ETA) testable without React.
 */
export class UploadManager {
  private readonly entries = new Map<string, Entry>();
  private files: FileDto[] = [];
  /** Where the next page of older files starts; undefined once the whole list is loaded. */
  private filesCursor?: string;
  private loadingMoreFiles = false;
  private readonly fileActions = new Map<string, FileAction>();
  /** Files deleted in this session. The by-user index is eventually consistent, so a list may still show them. */
  private readonly deletedIds = new Set<string>();
  private connection: ConnectionState = 'connecting';
  private concurrency: number;
  private snapshot: ManagerSnapshot;
  private readonly listeners = new Set<() => void>();
  private notifyTimer?: ReturnType<typeof setTimeout>;
  private restoring?: Promise<void>;
  private readonly now: () => number;

  constructor(private readonly deps: ManagerDeps) {
    this.now = deps.now ?? Date.now;
    this.concurrency = this.readConcurrency();
    this.snapshot = this.build();
  }

  // ------------------------------------------------------------------ store API
  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };
  getSnapshot = (): ManagerSnapshot => this.snapshot;

  /**
   * Applies the newest page of files (from the live stream or a refresh). A page without a cursor
   * is the complete list and replaces everything. Otherwise it replaces only the files it covers,
   * so older pages the user has already loaded stay put.
   */
  applyFirstPage({ files: received, nextCursor }: FilePage): void {
    const files = received.filter((f) => !this.deletedIds.has(f.id));
    if (!nextCursor) {
      this.files = files;
      this.filesCursor = undefined;
    } else {
      const oldest = received.at(-1)?.createdAt;
      const inPage = new Set(received.map((f) => f.id));
      const older = oldest === undefined ? [] : this.files.filter((f) => !inPage.has(f.id) && f.createdAt <= oldest);
      this.files = [...files, ...older];
      // Nothing older is loaded, so the page's own cursor is the way to older files.
      if (older.length === 0) this.filesCursor = nextCursor;
    }
    this.publish(true);
  }

  /** Gets a short-lived link for the original file and starts saving it. */
  async downloadFile(fileId: string): Promise<void> {
    await this.runFileAction(fileId, 'download', async () => {
      const link = await this.deps.api.getDownloadUrl?.(fileId);
      if (link) this.deps.startDownload?.(link.url);
    });
  }

  /** Permanently deletes a finished file. It leaves the list straight away; a refusal is shown on the row. */
  async deleteFile(fileId: string): Promise<void> {
    await this.runFileAction(fileId, 'delete', async () => {
      await this.deps.api.deleteFile?.(fileId);
      this.deletedIds.add(fileId);
      this.files = this.files.filter((f) => f.id !== fileId);
    });
  }

  dismissFileError(fileId: string): void {
    if (this.fileActions.delete(fileId)) this.publish(true);
  }

  private async runFileAction(fileId: string, kind: 'download' | 'delete', run: () => Promise<void>): Promise<void> {
    if (this.fileActions.get(fileId)?.busy) return;
    this.fileActions.set(fileId, { busy: kind });
    this.publish(true);
    try {
      await run();
      this.fileActions.delete(fileId);
    } catch (err) {
      this.fileActions.set(fileId, { error: err instanceof Error ? err.message : 'Something went wrong' });
    }
    this.publish(true);
  }

  /** Fetches the next page of older files. A failure keeps the cursor so it can be retried. */
  async loadMoreFiles(): Promise<void> {
    const cursor = this.filesCursor;
    if (!cursor || this.loadingMoreFiles || !this.deps.api.listFilesPage) return;
    this.loadingMoreFiles = true;
    this.publish(true);
    try {
      const page = await this.deps.api.listFilesPage({ cursor });
      if (this.filesCursor !== cursor) return; // the list was replaced while we waited
      const have = new Set(this.files.map((f) => f.id));
      this.files = [...this.files, ...page.files.filter((f) => !have.has(f.id) && !this.deletedIds.has(f.id))];
      this.filesCursor = page.nextCursor;
    } catch {
      /* keep what we have; the button stays so the user can retry */
    } finally {
      this.loadingMoreFiles = false;
      this.publish(true);
    }
  }

  setConnection(state: ConnectionState): void {
    if (state === this.connection) return;
    this.connection = state;
    this.publish(true);
  }

  setConcurrency(n: number): void {
    this.concurrency = Math.min(16, Math.max(1, Math.round(n)));
    try {
      this.deps.storage?.setItem(CONCURRENCY_KEY, String(this.concurrency));
    } catch {
      /* storage unavailable: setting just won't persist */
    }
    this.publish(true);
  }

  // -------------------------------------------------------------------- actions
  /** Reload recovery: surface sessions saved in IndexedDB, and auto-resume where permission allows. */
  restore(): Promise<void> {
    // Idempotent: React StrictMode (and hot reloads) may call this more than once.
    this.restoring ??= this.doRestore();
    return this.restoring;
  }

  private async doRestore(): Promise<void> {
    const saved = await this.deps.store.list();
    for (const persisted of saved) {
      if (this.hasFile(persisted.fileId)) continue;
      const handle = await this.deps.store.getHandle?.(persisted.fileId);
      const localId = crypto.randomUUID();
      const entry: Entry = { view: this.viewFromPersisted(localId, persisted, !!handle), samples: [], persisted, handle };
      this.entries.set(localId, entry);
    }
    this.publish(true);
    // Chromium remembers read access for files it has seen: continue without any click.
    for (const [localId, entry] of this.entries) {
      if (entry.handle && (await entry.handle.queryPermission?.({ mode: 'read' })) === 'granted') {
        await this.resume(localId).catch(() => undefined);
      }
    }
  }

  /** Start uploading a file the user just chose. */
  async add(file: File, handle?: FileSystemFileHandle): Promise<string> {
    const localId = crypto.randomUUID();
    const entry: Entry = {
      view: {
        localId,
        fileName: file.name,
        contentType: contentTypeOf(file),
        size: file.size,
        lastModified: file.lastModified,
        phase: 'idle',
        bytesUploaded: 0,
        partsDone: 0,
        partCount: 0,
        activeParts: 0,
        bytesPerSecond: 0,
        partStates: new Uint8Array(0),
        canReopenFile: !!handle,
      },
      file,
      handle,
      samples: [],
    };
    this.entries.set(localId, entry);
    this.begin(localId, entry);
    return localId;
  }

  /**
   * Continue a paused / failed / interrupted upload. For an interrupted one, the file comes from
   * the stored handle (one click) or from `picked` (the user selects it again).
   */
  async resume(localId: string, picked?: File): Promise<void> {
    const entry = this.entries.get(localId);
    if (!entry) return;
    if (entry.upload) {
      void entry.upload.start().catch(() => undefined);
      return;
    }
    const persisted = entry.persisted;
    if (!persisted) return;
    let file = picked;
    if (!file && entry.handle) {
      const ok =
        (await entry.handle.queryPermission?.({ mode: 'read' })) === 'granted' || (await entry.handle.requestPermission?.({ mode: 'read' })) === 'granted';
      if (!ok) return this.fail(entry, 'Permission to read the file was not granted. Choose the file again.');
      file = await entry.handle.getFile();
    }
    if (!file) return;
    if (file.size !== persisted.fileSize || file.name !== persisted.fileName) {
      return this.fail(entry, `That is not the same file. Choose "${persisted.fileName}" (${persisted.fileSize} bytes).`);
    }
    entry.file = file;
    entry.view.error = undefined;
    this.begin(localId, entry, persisted);
  }

  pause(localId: string): void {
    this.entries.get(localId)?.upload?.pause();
  }

  async cancel(localId: string): Promise<void> {
    const entry = this.entries.get(localId);
    if (!entry) return;
    if (entry.upload) await entry.upload.cancel();
    else if (entry.persisted) {
      await this.deps.api.abort(entry.persisted.fileId).catch(() => undefined);
      await this.deps.store.delete(entry.persisted.fileId);
    }
    this.entries.delete(localId);
    this.publish(true);
    await this.refreshFiles();
  }

  async refreshFiles(): Promise<void> {
    try {
      const page = await this.deps.api.listFilesPage?.();
      if (page) this.applyFirstPage(page);
    } catch {
      /* the live stream will catch up */
    }
  }

  // ------------------------------------------------------------------ internals
  private begin(localId: string, entry: Entry, persisted?: PersistedUpload): void {
    const file = entry.file!;
    const upload = new Upload(
      { api: this.deps.api, transport: this.deps.transport, store: this.deps.store },
      this.deps.makeSource(file),
      { fileName: file.name, contentType: entry.view.contentType, lastModified: file.lastModified },
      { concurrency: this.concurrency, ...this.deps.uploadOptions },
      persisted,
    );
    entry.upload = upload;
    entry.samples = [];
    upload.subscribe((p) => {
      const firstSightOfFileId = !!p.fileId && !entry.view.fileId;
      this.onProgress(entry, p);
      // Keep the handle next to the session so a reload can reopen the file without a picker.
      if (firstSightOfFileId && entry.handle) void this.deps.store.putHandle?.(p.fileId!, entry.handle);
      this.publish();
    });
    this.onProgress(entry, upload.progress);
    this.publish(true);

    upload.start().then(
      (outcome) => {
        if (outcome.type === 'done' || outcome.type === 'cancelled') {
          this.entries.delete(localId);
          this.publish(true);
          void this.refreshFiles();
        }
      },
      (err: unknown) => this.fail(entry, err instanceof Error ? err.message : String(err)),
    );
  }

  private onProgress(entry: Entry, p: UploadProgress): void {
    const v = entry.view;
    const t = this.now();
    v.fileId = p.fileId ?? v.fileId;
    v.phase = p.phase;
    v.bytesUploaded = p.bytesUploaded;
    v.partsDone = p.partsDone;
    v.partCount = p.partCount;
    v.activeParts = p.activeParts;
    v.restarted = p.restarted;
    v.error = p.error ?? v.error;
    v.partStates = entry.upload?.partStates() ?? v.partStates;

    if (p.phase === 'uploading') {
      entry.samples.push({ t, bytes: p.bytesUploaded });
      while (entry.samples.length > 2 && t - entry.samples[0]!.t > SPEED_WINDOW_MS) entry.samples.shift();
      const first = entry.samples[0]!;
      const dt = (t - first.t) / 1000;
      v.bytesPerSecond = dt > 0.5 ? Math.max(0, (p.bytesUploaded - first.bytes) / dt) : v.bytesPerSecond;
      v.etaSeconds = v.bytesPerSecond > 0 ? (v.size - p.bytesUploaded) / v.bytesPerSecond : undefined;
    } else {
      entry.samples = [];
      v.bytesPerSecond = 0;
      v.etaSeconds = undefined;
    }
  }

  private fail(entry: Entry, message: string): void {
    entry.view.error = message;
    entry.view.phase = entry.upload ? 'error' : 'interrupted';
    this.publish(true);
  }

  private viewFromPersisted(localId: string, p: PersistedUpload, canReopenFile: boolean): LocalUpload {
    const doneBytes = Object.values(p.parts).reduce((n, part) => n + part.size, 0);
    const states = new Uint8Array(p.partCount);
    for (const n of Object.keys(p.parts)) states[Number(n) - 1] = 2;
    return {
      localId,
      fileId: p.fileId,
      fileName: p.fileName,
      contentType: p.contentType,
      size: p.fileSize,
      lastModified: p.lastModified,
      phase: 'interrupted',
      bytesUploaded: doneBytes,
      partsDone: Object.keys(p.parts).length,
      partCount: p.partCount,
      activeParts: 0,
      bytesPerSecond: 0,
      partStates: states,
      canReopenFile,
    };
  }

  private hasFile(fileId: string): boolean {
    return [...this.entries.values()].some((e) => e.view.fileId === fileId);
  }

  private readConcurrency(): number {
    const stored = Number(this.deps.storage?.getItem(CONCURRENCY_KEY));
    const n = stored >= 1 ? stored : (this.deps.concurrency ?? 4);
    return Math.min(16, Math.max(1, Math.round(n)));
  }

  private build(): ManagerSnapshot {
    return {
      local: [...this.entries.values()].map((e) => ({ ...e.view })),
      files: this.files,
      hasMoreFiles: this.filesCursor !== undefined,
      loadingMoreFiles: this.loadingMoreFiles,
      fileActions: Object.fromEntries(this.fileActions),
      connection: this.connection,
      concurrency: this.concurrency,
    };
  }

  /** Progress events arrive many times a second; coalesce them so React renders ~10 fps. */
  private publish(immediate = false): void {
    const flush = () => {
      this.notifyTimer = undefined;
      this.snapshot = this.build();
      for (const fn of this.listeners) fn();
    };
    if (immediate) {
      if (this.notifyTimer) clearTimeout(this.notifyTimer);
      flush();
    } else if (!this.notifyTimer) {
      this.notifyTimer = setTimeout(flush, 100);
    }
  }
}

function contentTypeOf(file: File): string {
  if (file.type) return file.type;
  const ext = file.name.split('.').pop()?.toLowerCase();
  const byExt: Record<string, string> = {
    bin: 'application/octet-stream',
    dat: 'application/octet-stream',
    mp4: 'video/mp4',
    mov: 'video/quicktime',
    zip: 'application/zip',
    gz: 'application/gzip',
    csv: 'text/csv',
    txt: 'text/plain',
    pdf: 'application/pdf',
  };
  return (ext && byExt[ext]) || 'application/octet-stream';
}
