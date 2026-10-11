import {
  HttpError,
  MemoryResumeStore,
  Upload,
  MiB,
  type FileDto,
  type ListPartsResponse,
  type PartSource,
  type PartTransport,
  type PresignPartResponse,
  type PutRequest,
  type RemotePart,
  type UploadApi,
  type UploadOptions,
} from './index';

const FILE_SIZE = 5 * 5 * MiB + 123; // 5 MiB parts -> 6 parts (last one tiny)
const PART_SIZE = 5 * MiB;

class BufferSource implements PartSource {
  readonly size: number;
  constructor(private readonly data: Uint8Array) {
    this.size = data.byteLength;
  }
  async read(start: number, end: number) {
    return this.data.subarray(start, end);
  }
}

function makeData(size: number, seed = 7): Uint8Array {
  const data = new Uint8Array(size);
  let x = seed;
  for (let i = 0; i < size; i++) {
    x = (x * 1103515245 + 12345) & 0x7fffffff;
    data[i] = x & 0xff;
  }
  return data;
}

/** Fake S3 + API sharing one multipart state, so reconciliation is realistic. */
class FakeBackend implements UploadApi, PartTransport {
  status: FileDto['status'] = 'uploading';
  parts = new Map<number, RemotePart>();
  puts: number[] = [];
  initCalls = 0;
  completeCalls = 0;
  abortCalls = 0;
  gone = false;
  inFlight = 0;
  maxInFlight = 0;
  failures = new Map<number, Array<HttpError>>();
  block?: Promise<void>;

  file(): FileDto {
    return {
      id: 'f1', fileName: 'big.bin', contentType: 'application/octet-stream', size: FILE_SIZE, status: this.status,
      partSize: PART_SIZE, partCount: 6, createdAt: 't', updatedAt: 't',
    };
  }
  async init() {
    this.initCalls++;
    this.gone = false;
    this.parts.clear();
    return this.file();
  }
  async listParts(): Promise<ListPartsResponse> {
    if (this.gone) throw new HttpError('gone', 410);
    return { file: this.file(), parts: [...this.parts.values()] };
  }
  async presignPart(_id: string, partNumber: number, sha256: string): Promise<PresignPartResponse> {
    return { url: `https://s3.test/${partNumber}?sha=${encodeURIComponent(sha256)}`, method: 'PUT', headers: { 'x-amz-checksum-sha256': sha256 }, expiresAt: 'x' };
  }
  async complete() {
    this.completeCalls++;
    this.status = 'uploaded';
    return this.file();
  }
  async abort() {
    this.abortCalls++;
  }
  async put(req: PutRequest) {
    const partNumber = Number(new URL(req.url).pathname.slice(1));
    this.puts.push(partNumber);
    this.inFlight++;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    try {
      const queued = this.failures.get(partNumber);
      if (queued?.length) throw queued.shift()!;
      if (this.block) {
        await Promise.race([
          this.block,
          new Promise((_, reject) => req.signal.addEventListener('abort', () => reject(Object.assign(new Error('Aborted'), { name: 'AbortError' })))),
        ]);
      } else {
        await new Promise((r) => setTimeout(r, 1));
      }
      if (req.signal.aborted) throw Object.assign(new Error('Aborted'), { name: 'AbortError' });
      req.onProgress(req.body.byteLength);
      this.parts.set(partNumber, { partNumber, size: req.body.byteLength, sha256: req.headers['x-amz-checksum-sha256'] });
    } finally {
      this.inFlight--;
    }
  }
}

function setup(overrides: Partial<UploadOptions> = {}) {
  const backend = new FakeBackend();
  const store = new MemoryResumeStore();
  const data = makeData(FILE_SIZE);
  const sleeps: number[] = [];
  const options: Partial<UploadOptions> = {
    concurrency: 3,
    maxRetries: 3,
    baseDelayMs: 100,
    maxDelayMs: 1000,
    random: () => 0.999,
    sleep: async (ms) => void sleeps.push(ms),
    ...overrides,
  };
  const make = (persisted?: Parameters<typeof store.get>[0] extends never ? never : Awaited<ReturnType<typeof store.get>>) =>
    new Upload(
      { api: backend, transport: backend, store },
      new BufferSource(data),
      { fileName: 'big.bin', contentType: 'application/octet-stream', lastModified: 1 },
      options,
      persisted,
    );
  return { backend, store, make, sleeps, data };
}

describe('Upload engine', () => {
  it('uploads every part within the concurrency limit, completes once, and clears local state', async () => {
    const { backend, store, make } = setup();
    const up = make();
    const out = await up.start();
    expect(out.type).toBe('done');
    expect([...backend.parts.keys()].sort()).toEqual([1, 2, 3, 4, 5, 6]);
    expect(backend.maxInFlight).toBeLessThanOrEqual(3);
    expect(backend.maxInFlight).toBeGreaterThan(1);
    expect(backend.completeCalls).toBe(1);
    expect(store.items.size).toBe(0);
    expect(up.progress).toMatchObject({ phase: 'done', bytesUploaded: FILE_SIZE, partsDone: 6 });
  });

  it('retries a failing part with capped exponential backoff', async () => {
    const { backend, make, sleeps } = setup({ maxRetries: 5, baseDelayMs: 100, maxDelayMs: 350 });
    backend.failures.set(2, [new HttpError('boom', 503), new HttpError('boom', 500), new HttpError('net'), new HttpError('boom', 503)]);
    const out = await make().start();
    expect(out.type).toBe('done');
    expect(backend.puts.filter((n) => n === 2)).toHaveLength(5);
    // random()=0.999 -> ~full window: 100, 200, 350 (capped), 350
    expect(sleeps).toEqual([99, 199, 349, 349]);
  });

  it('gives up after maxRetries, surfaces the error, and keeps finished parts for resume', async () => {
    const { backend, store, make } = setup({ maxRetries: 2, concurrency: 1 });
    backend.failures.set(3, Array.from({ length: 10 }, () => new HttpError('boom', 500)));
    const up = make();
    await expect(up.start()).rejects.toThrow('boom');
    expect(up.progress.phase).toBe('error');
    expect(backend.puts.filter((n) => n === 3)).toHaveLength(3);
    const saved = await store.get('f1');
    expect(Object.keys(saved!.parts).map(Number)).toEqual([1, 2]);
    expect(backend.completeCalls).toBe(0);
  });

  it('does not retry non-retryable client errors', async () => {
    const { backend, make } = setup({ concurrency: 1 });
    backend.failures.set(1, [new HttpError('forbidden', 403)]);
    await expect(make().start()).rejects.toThrow('forbidden');
    expect(backend.puts.filter((n) => n === 1)).toHaveLength(1);
  });

  it('pauses without losing progress, then resumes only the missing parts', async () => {
    const { backend, store, make } = setup({ concurrency: 1 });
    let release!: () => void;
    const up = make();
    // Let parts 1-2 through, then block part 3.
    const origPut = backend.put.bind(backend);
    backend.put = async (req) => {
      if (Number(new URL(req.url).pathname.slice(1)) === 3) backend.block = new Promise<void>((r) => (release = r));
      return origPut(req);
    };
    const running = up.start();
    await waitFor(() => backend.puts.includes(3));
    up.pause();
    expect(await running).toEqual({ type: 'paused' });
    expect(up.progress.phase).toBe('paused');
    expect(Object.keys((await store.get('f1'))!.parts).map(Number)).toEqual([1, 2]);

    backend.put = origPut;
    backend.block = undefined;
    backend.puts = [];
    const out = await up.start(); // same object resumes
    expect(out.type).toBe('done');
    expect(backend.puts.sort()).toEqual([3, 4, 5, 6]);
    expect(backend.initCalls).toBe(1);
    release?.();
  });

  it('resumes after a "page reload" from persisted state, uploading only what S3 lacks', async () => {
    const first = setup({ concurrency: 1 });
    first.backend.failures.set(4, Array.from({ length: 10 }, () => new HttpError('boom', 500)));
    await expect(first.make().start()).rejects.toThrow();
    const persisted = await first.store.get('f1');
    expect(Object.keys(persisted!.parts).map(Number)).toEqual([1, 2, 3]);

    // New Upload object (new page load), same backend and store, fresh failures.
    first.backend.failures.clear();
    first.backend.puts = [];
    const out = await first.make(persisted).start();
    expect(out.type).toBe('done');
    expect(first.backend.puts.sort()).toEqual([4, 5, 6]);
    expect(first.backend.initCalls).toBe(1);
  });

  it('re-uploads a part that S3 lost even though local state says it is done', async () => {
    const { backend, store, make } = setup({ concurrency: 1 });
    backend.failures.set(5, Array.from({ length: 10 }, () => new HttpError('boom', 500)));
    await expect(make().start()).rejects.toThrow();
    backend.failures.clear();
    backend.parts.delete(2); // e.g. part overwritten/aborted server-side
    backend.puts = [];
    const out = await make(await store.get('f1')).start();
    expect(out.type).toBe('done');
    expect(backend.puts.sort()).toEqual([2, 5, 6]);
  });

  it('verifies remote parts by hashing the file when local state was wiped', async () => {
    const { backend, store, make } = setup({ concurrency: 1 });
    backend.failures.set(4, Array.from({ length: 10 }, () => new HttpError('boom', 500)));
    await expect(make().start()).rejects.toThrow();
    const persisted = (await store.get('f1'))!;
    persisted.parts = {}; // IndexedDB cleared
    // Corrupt what S3 holds for part 2 (different content hash).
    backend.parts.set(2, { ...backend.parts.get(2)!, sha256: 'tampered' });
    backend.failures.clear();
    backend.puts = [];
    const out = await make(persisted).start();
    expect(out.type).toBe('done');
    expect(backend.puts.sort()).toEqual([2, 4, 5, 6]);
  });

  it('starts over when the server says the multipart upload is gone', async () => {
    const { backend, store, make } = setup({ concurrency: 1 });
    backend.failures.set(3, Array.from({ length: 10 }, () => new HttpError('boom', 500)));
    await expect(make().start()).rejects.toThrow();
    backend.failures.clear();
    backend.gone = true;
    const persisted = await store.get('f1');
    const up = make(persisted);
    backend.puts = [];
    // init() resets `gone`, mirroring a brand-new upload id.
    const out = await up.start();
    expect(out.type).toBe('done');
    expect(backend.initCalls).toBe(2);
    expect(backend.puts.sort()).toEqual([1, 2, 3, 4, 5, 6]);
    expect(up.progress.restarted).toBe(true);
  });

  it('returns the file straight away if the server already completed it', async () => {
    const { backend, store, make } = setup({ concurrency: 1 });
    backend.failures.set(6, Array.from({ length: 10 }, () => new HttpError('boom', 500)));
    await expect(make().start()).rejects.toThrow();
    backend.status = 'processing';
    backend.puts = [];
    const out = await make(await store.get('f1')).start();
    expect(out.type).toBe('done');
    expect(backend.puts).toEqual([]);
    expect(backend.completeCalls).toBe(0);
  });

  it('cancel aborts server-side and clears local state', async () => {
    const { backend, store, make } = setup({ concurrency: 2 });
    backend.block = new Promise(() => undefined);
    const up = make();
    const running = up.start();
    await waitFor(() => backend.puts.length >= 1);
    await up.cancel();
    expect(await running).toEqual({ type: 'cancelled' });
    expect(backend.abortCalls).toBe(1);
    expect(store.items.size).toBe(0);
    expect(up.progress.phase).toBe('cancelled');
  });

  it('rejects resuming with a different file', () => {
    const { make } = setup();
    expect(() => make({ fileId: 'f1', fileName: 'x', contentType: 'x', fileSize: 1, lastModified: 1, partSize: 1, partCount: 1, parts: {}, createdAt: '', updatedAt: '' })).toThrow(/different size/);
  });

  it('reports monotonic byte progress', async () => {
    const { make } = setup({ concurrency: 2 });
    const up = make();
    const seen: number[] = [];
    up.subscribe((p) => seen.push(p.bytesUploaded));
    await up.start();
    expect(seen.length).toBeGreaterThan(6);
    expect(seen.at(-1)).toBe(FILE_SIZE);
    for (let i = 1; i < seen.length; i++) expect(seen[i]).toBeGreaterThanOrEqual(seen[i - 1]!);
  });
});

async function waitFor(cond: () => boolean, timeoutMs = 2000) {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 2));
  }
}
