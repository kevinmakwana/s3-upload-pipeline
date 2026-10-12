import 'fake-indexeddb/auto';
import { HttpError, MiB, type FileDto, type PartTransport, type PutRequest, type UploadApi } from '@s3up/core';
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

function makeManager(backend: Backend, dbName: string, storage?: Pick<Storage, 'getItem' | 'setItem'>) {
  return new UploadManager({
    api: backend, transport: backend, store: new IndexedDbResumeStore(dbName), makeSource: (f) => new BrowserFileSource(f),
    uploadOptions: { maxRetries: 0, sleep: async () => undefined }, concurrency: 2, storage,
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
      new UploadManager({ api: backend, transport: backend, store, makeSource: (f) => new BrowserFileSource(f), uploadOptions: { maxRetries: 0, sleep: async () => undefined }, concurrency: 2 });

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
    const m = makeManager(new Backend(), 'm5', storage);
    expect(m.getSnapshot().concurrency).toBe(2);
    m.setConcurrency(99);
    expect(m.getSnapshot().concurrency).toBe(16);
    m.setConcurrency(0);
    expect(m.getSnapshot().concurrency).toBe(1);
    expect(mem.get(CONCURRENCY_KEY)).toBe('1');
    expect(makeManager(new Backend(), 'm6', storage).getSnapshot().concurrency).toBe(1);
  });
});
