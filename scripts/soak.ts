/**
 * Soak test: push a huge synthetic file through the running stack, interrupt it part-way, resume,
 * and confirm the worker's checksum matches. The bytes are generated on the fly, so no disk is used.
 *
 *   npm run soak -- 15            # 15 GiB against http://localhost:3001
 *   API_URL=http://host:3001 npm run soak -- 5
 */
import { createHash, randomBytes } from 'node:crypto';
import { HttpUploadApi, MemoryResumeStore, MiB, Upload, type PartSource, type PartTransport, type PutRequest, HttpError } from '@s3up/core';

const GiB = 1024 * MiB;
const sizeGiB = Number(process.argv[2] ?? 5);
const apiUrl = process.env.API_URL ?? 'http://localhost:3001';
const size = Math.floor(sizeGiB * GiB);

/** Deterministic pseudo-content: a random 1 MiB block with each MiB stamped by its index. */
class SyntheticSource implements PartSource {
  private readonly block = randomBytes(MiB);
  constructor(readonly size: number) {}
  async read(start: number, end: number): Promise<Uint8Array> {
    const out = Buffer.allocUnsafe(end - start);
    for (let pos = start; pos < end;) {
      const mib = Math.floor(pos / MiB);
      const offsetInMib = pos - mib * MiB;
      const n = Math.min(MiB - offsetInMib, end - pos);
      this.block.copy(out, pos - start, offsetInMib, offsetInMib + n);
      // Stamp the MiB index into its first 8 bytes so no two blocks are identical.
      for (let i = 0; i < 8; i++) {
        const abs = mib * MiB + i;
        if (abs >= pos && abs < pos + n) out[abs - start] = (mib / 256 ** i) & 0xff;
      }
      pos += n;
    }
    return out;
  }
}

class FetchTransport implements PartTransport {
  async put(req: PutRequest) {
    let res: Response;
    try {
      res = await fetch(req.url, { method: 'PUT', headers: req.headers, body: req.body as Uint8Array<ArrayBuffer>, signal: req.signal });
    } catch (err) {
      if ((err as Error).name === 'AbortError') throw err;
      throw new HttpError((err as Error).message);
    }
    if (!res.ok) throw new HttpError(`S3 PUT ${res.status}`, res.status);
    req.onProgress(req.body.byteLength);
  }
}

const fmt = (b: number) => `${(b / GiB).toFixed(2)} GiB`;
const mark = (label: string, t0: number) => console.log(`[${((Date.now() - t0) / 1000).toFixed(0).padStart(4)}s] ${label}`);

async function main() {
  const t0 = Date.now();
  const source = new SyntheticSource(size);
  const api = new HttpUploadApi({ baseUrl: apiUrl, userId: `soak-${Math.random().toString(36).slice(2, 8)}` });
  const store = new MemoryResumeStore();
  const meta = { fileName: 'soak.bin', contentType: 'application/octet-stream', lastModified: 1 };
  const deps = { api, transport: new FetchTransport(), store };

  mark(`hashing ${fmt(size)} locally for the expected checksum`, t0);
  const hash = createHash('sha256');
  for (let off = 0; off < size; off += 64 * MiB) hash.update(await source.read(off, Math.min(off + 64 * MiB, size)));
  const expected = hash.digest('hex');

  mark('uploading (will interrupt at ~40%)', t0);
  const first = new Upload(deps, source, meta, { concurrency: 4 });
  let lastLog = 0;
  let interrupted = false;
  first.subscribe((p) => {
    if (Date.now() - lastLog > 5000) {
      lastLog = Date.now();
      mark(`  ${fmt(p.bytesUploaded)} / ${fmt(p.totalBytes)}  (${p.partsDone}/${p.partCount} parts)`, t0);
    }
    if (!interrupted && p.bytesUploaded > p.totalBytes * 0.4) {
      interrupted = true;
      first.pause();
    }
  });
  const outcome = await first.start();
  if (outcome.type !== 'paused') throw new Error(`expected pause, got ${outcome.type}`);
  const fileId = first.progress.fileId!;
  const saved = (await store.get(fileId))!;
  mark(`interrupted with ${Object.keys(saved.parts).length}/${saved.partCount} parts saved; resuming from a fresh session`, t0);

  const second = new Upload(deps, source, meta, { concurrency: 4 }, saved);
  const done = await second.start();
  if (done.type !== 'done') throw new Error(`expected done, got ${done.type}`);
  mark(`upload complete, status "${done.file.status}"; waiting for the worker`, t0);

  for (;;) {
    const f = await api.getFile(fileId);
    if (f.status === 'ready' || f.status === 'failed') {
      mark(`status "${f.status}"`, t0);
      if (f.status === 'failed') throw new Error(f.error);
      const ok = f.result?.sha256 === expected;
      console.log(
        `\nworker sha256  ${f.result?.sha256}\nexpected       ${expected}\n${ok ? 'MATCH' : 'MISMATCH'}  (${f.partCount} parts of ${fmt(f.partSize)}, total ${((Date.now() - t0) / 1000).toFixed(0)}s)`,
      );
      process.exit(ok ? 0 : 1);
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
