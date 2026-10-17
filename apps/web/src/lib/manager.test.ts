import 'fake-indexeddb/auto';
import { HttpError, MiB, type FileDto, type FilePage, type PartTransport, type PutRequest, type UploadApi } from '@s3up/core';
import { BrowserFileSource } from './browser-source';
import { IndexedDbResumeStore } from './idb-store';
import { CONCURRENCY_KEY, UploadManager } from './manager';

const SIZE = 12 * MiB;

/** Minimal in-memory backend: init/list/presign/complete plus a "S3" the transport writes to. */
class Backend implements UploadApi, PartTransport {
  parts = new Map<number, { partNumber: number; size: number; sha256: string }>();
  status: FileDto['status'] = 'uploading';
  puts: number[] = [];
  failPart?: number;
  file(): FileDto {
    return { id: 'f1', fileName: 'big.bin', contentType: 'application/octet-stream', size: SIZE, status: this.status, partSize: 5 * MiB, partCount: 3, createdAt: 't', updatedAt: 't' };
  }
  async init() { return this.file(); }
  async listParts() { return { file: this.file(), parts: [...this.parts.values()] }; }
  async presignPart(_id: string, n: number, sha: string) { return { url: `https://s3/${n}`, method: 'PUT' as const, headers: { sha }, expiresAt: '' }; }
  async complete() { this.status = 'uploaded'; return this.file(); }
  async abort() { /* noop */ }
  async put(req: PutRequest) {
    const n = Number(new URL(req.url).pathname.slice(1));
    this.puts.push(n);
    if (n === this.failPart) throw new HttpError('boom', 403, false);
    this.parts.set(n, { partNumber: n, size: req.body.byteLength, sha256: req.headers.sha! });
  }
}

const bigFile = () => new File([new Uint8Array(SIZE).fill(7)], 'big.bin', { type: 'application/octet-stream', lastModified: 42 });
const tick = () => new Promise((r) => setTimeout(r, 20));
async function until(cond: () => boolean) {
  for (let i = 0; i < 200 && !cond(); i++) await tick();
  if (!cond()) throw new Error('condition not met');
}

/** One worker by default: part order is then deterministic, so "parts 1-2 landed, part 3 failed" holds. */
function makeManager(backend: Backend, dbName: string, storage?: Pick<Storage, 'getItem' | 'setItem'>, concurrency = 1) {
  return new UploadManager({
    api: backend, transport: backend, store: new IndexedDbResumeStore(dbName), makeSource: (f) => new BrowserFileSource(f),
    uploadOptions: { maxRetries: 0, sleep: async () => undefined }, concurrency, storage,
  });
}

describe('UploadManager', () => {
  it('uploads a file and clears the local session when done', async () => {
    const backend = new Backend();
    const m = makeManager(backend, 'm1');
    await m.add(bigFile());
    await until(() => backend.status === 'uploaded');
    await until(() => m.getSnapshot().local.length === 0);
  });

  it('after a reload, lists the interrupted upload and resumes only the missing parts from the picked file', async () => {
    const backend = new Backend();
    backend.failPart = 3; // parts 1-2 land, then the "tab closes"
    const first = makeManager(backend, 'm2');
    await first.add(bigFile());
    await until(() => first.getSnapshot().local[0]?.phase === 'error');
    expect(first.getSnapshot().local[0]!.partsDone).toBe(2);

    // New manager + same IndexedDB = a page reload.
    backend.failPart = undefined;
    backend.puts = [];
    const reloaded = makeManager(backend, 'm2');
    await reloaded.restore();
    const [item] = reloaded.getSnapshot().local;
    expect(item).toMatchObject({ phase: 'interrupted', fileId: 'f1', partsDone: 2, partCount: 3, canReopenFile: false });
    expect([...item!.partStates]).toEqual([2, 2, 0]);

    await reloaded.resume(item!.localId, bigFile());
    await until(() => backend.status === 'uploaded');
    expect(backend.puts).toEqual([3]);
    await until(() => reloaded.getSnapshot().local.length === 0);
  });

  it('stores the file handle with the session, and on reload resumes without a file picker', async () => {
    const backend = new Backend();
    backend.failPart = 3;
    const handle = {
      kind: 'file',
      queryPermission: async () => 'granted',
      requestPermission: async () => 'granted',
      getFile: async () => bigFile(),
    } as unknown as FileSystemFileHandle;
    const store = new IndexedDbResumeStore('m-handle');
    const handles = new Map<string, FileSystemFileHandle>();
    // fake-indexeddb can't clone this fake handle, so keep handles beside the real store.
    store.putHandle = async (id, h) => void handles.set(id, h);
    store.getHandle = async (id) => handles.get(id);
    const make = () =>
      new UploadManager({ api: backend, transport: backend, store, makeSource: (f) => new BrowserFileSource(f), uploadOptions: { maxRetries: 0, sleep: async () => undefined }, concurrency: 1 });

    const first = make();
    await first.add(bigFile(), handle);
    await until(() => first.getSnapshot().local[0]?.phase === 'error');
    expect(handles.has('f1')).toBe(true);

    backend.failPart = undefined;
    backend.puts = [];
    const reloaded = make();
    await reloaded.restore(); // permission is already granted, so this continues on its own
    await until(() => backend.status === 'uploaded');
    expect(backend.puts).toEqual([3]);
  });

  it('refuses a different file when resuming and keeps the session', async () => {
    const backend = new Backend();
    backend.failPart = 2;
    const first = makeManager(backend, 'm3');
    await first.add(bigFile());
    await until(() => first.getSnapshot().local[0]?.phase === 'error');

    const reloaded = makeManager(backend, 'm3');
    await reloaded.restore();
    const id = reloaded.getSnapshot().local[0]!.localId;
    await reloaded.resume(id, new File([new Uint8Array(10)], 'other.bin'));
    const item = reloaded.getSnapshot().local[0]!;
    expect(item.phase).toBe('interrupted');
    expect(item.error).toMatch(/not the same file/);
  });

  it('cancelling an interrupted upload aborts it and forgets it', async () => {
    const backend = new Backend();
    backend.failPart = 2;
    const abort = jest.spyOn(backend, 'abort');
    const first = makeManager(backend, 'm4');
    await first.add(bigFile());
    await until(() => first.getSnapshot().local[0]?.phase === 'error');

    const reloaded = makeManager(backend, 'm4');
    await reloaded.restore();
    await reloaded.cancel(reloaded.getSnapshot().local[0]!.localId);
    expect(abort).toHaveBeenCalledWith('f1');
    expect(reloaded.getSnapshot().local).toEqual([]);
    const again = makeManager(backend, 'm4');
    await again.restore();
    expect(again.getSnapshot().local).toEqual([]);
  });

  it('remembers and clamps the concurrency setting', () => {
    const mem = new Map<string, string>();
    const storage = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v) };
    const m = makeManager(new Backend(), 'm5', storage, 2);
    expect(m.getSnapshot().concurrency).toBe(2);
    m.setConcurrency(99);
    expect(m.getSnapshot().concurrency).toBe(16);
    m.setConcurrency(0);
    expect(m.getSnapshot().concurrency).toBe(1);
    expect(mem.get(CONCURRENCY_KEY)).toBe('1');
    expect(makeManager(new Backend(), 'm6', storage).getSnapshot().concurrency).toBe(1);
  });
});

describe('UploadManager file list paging', () => {
  const dto = (n: number, extra: Partial<FileDto> = {}): FileDto => ({
    id: `f${n}`, fileName: `f${n}.bin`, contentType: 'application/octet-stream', size: 1, status: 'ready', partSize: 5 * MiB, partCount: 1,
    createdAt: `2026-01-01T00:00:0${n}.000Z`, updatedAt: `2026-01-01T00:00:0${n}.000Z`, ...extra,
  });
  const ids = (m: UploadManager) => m.getSnapshot().files.map((f) => f.id);

  /** A backend whose list answers come from `answer`, recording the options of each request. */
  function paged(answer: (opts: { limit?: number; cursor?: string }) => Promise<FilePage>) {
    const backend = Object.assign(new Backend(), { listFilesPage: jest.fn((opts: { limit?: number; cursor?: string } = {}) => answer(opts)) });
    return { backend, manager: makeManager(backend as Backend, `paging-${Math.random()}`) };
  }
  const threePages: Record<string, FilePage> = {
    first: { files: [dto(5), dto(4)], nextCursor: 'c1' },
    c1: { files: [dto(3), dto(2)], nextCursor: 'c2' },
    c2: { files: [dto(1)] },
  };
  const serve = async (o: { cursor?: string }) => threePages[o.cursor ?? 'first']!;

  it('shows the first page and offers more only while a cursor remains', async () => {
    const { manager } = paged(serve);
    expect(manager.getSnapshot()).toMatchObject({ files: [], hasMoreFiles: false, loadingMoreFiles: false });
    await manager.refreshFiles();
    expect(ids(manager)).toEqual(['f5', 'f4']);
    expect(manager.getSnapshot().hasMoreFiles).toBe(true);
  });

  it('loads older pages on demand and appends them in order', async () => {
    const { manager, backend } = paged(serve);
    await manager.refreshFiles();
    await manager.loadMoreFiles();
    expect(ids(manager)).toEqual(['f5', 'f4', 'f3', 'f2']);
    await manager.loadMoreFiles();
    expect(ids(manager)).toEqual(['f5', 'f4', 'f3', 'f2', 'f1']);
    expect(manager.getSnapshot().hasMoreFiles).toBe(false);
    expect(backend.listFilesPage.mock.calls.map(([o]) => o?.cursor)).toEqual([undefined, 'c1', 'c2']);
    await manager.loadMoreFiles(); // nothing left: no request
    expect(backend.listFilesPage).toHaveBeenCalledTimes(3);
  });

  it('does not start a second load while one is in flight', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { manager, backend } = paged(async (o) => (o.cursor ? (await gate, threePages.c1!) : threePages.first!));
    await manager.refreshFiles();
    const a = manager.loadMoreFiles();
    const b = manager.loadMoreFiles();
    expect(manager.getSnapshot().loadingMoreFiles).toBe(true);
    release();
    await Promise.all([a, b]);
    expect(backend.listFilesPage).toHaveBeenCalledTimes(2);
    expect(ids(manager)).toEqual(['f5', 'f4', 'f3', 'f2']);
    expect(manager.getSnapshot().loadingMoreFiles).toBe(false);
  });

  it('keeps the list and the cursor when loading more fails, so it can be retried', async () => {
    let fail = true;
    const { manager } = paged(async (o) => {
      if (o.cursor && fail) throw new Error('offline');
      return serve(o);
    });
    await manager.refreshFiles();
    await manager.loadMoreFiles();
    expect(ids(manager)).toEqual(['f5', 'f4']);
    expect(manager.getSnapshot()).toMatchObject({ hasMoreFiles: true, loadingMoreFiles: false });
    fail = false;
    await manager.loadMoreFiles();
    expect(ids(manager)).toEqual(['f5', 'f4', 'f3', 'f2']);
  });

  describe('live updates (the newest page pushed over SSE)', () => {
    async function loaded() {
      const ctx = paged(serve);
      await ctx.manager.refreshFiles();
      await ctx.manager.loadMoreFiles();
      return ctx.manager; // f5 f4 | f3 f2 loaded, c2 still to fetch
    }

    it('updates the newest page in place and keeps the older pages already loaded', async () => {
      const m = await loaded();
      m.applyFirstPage({ files: [dto(6), dto(5, { status: 'failed' }), dto(4)], nextCursor: 'x' });
      expect(ids(m)).toEqual(['f6', 'f5', 'f4', 'f3', 'f2']);
      expect(m.getSnapshot().files[1]!.status).toBe('failed');
      expect(m.getSnapshot().hasMoreFiles).toBe(true);
      await m.loadMoreFiles(); // still continues from where the older pages ended, not from the live page
      expect(ids(m)).toEqual(['f6', 'f5', 'f4', 'f3', 'f2', 'f1']);
    });

    it('drops a newer file that is gone from the page (for example an aborted upload)', async () => {
      const m = await loaded();
      m.applyFirstPage({ files: [dto(4)], nextCursor: 'x' });
      expect(ids(m)).toEqual(['f4', 'f3', 'f2']);
    });

    it('treats a page with no cursor as the complete list', async () => {
      const m = await loaded();
      m.applyFirstPage({ files: [dto(5)] });
      expect(ids(m)).toEqual(['f5']);
      expect(m.getSnapshot().hasMoreFiles).toBe(false);
    });

    it('adopts the live cursor when no older page has been loaded yet', () => {
      const { manager, backend } = paged(serve);
      manager.applyFirstPage({ files: [dto(5), dto(4)], nextCursor: 'live-1' });
      expect(manager.getSnapshot().hasMoreFiles).toBe(true);
      return manager.loadMoreFiles().then(() => expect(backend.listFilesPage.mock.calls[0]![0]).toMatchObject({ cursor: 'live-1' }));
    });
  });
});
