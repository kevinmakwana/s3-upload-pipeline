import { open, type FileHandle } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { NestFactory } from '@nestjs/core';
import type { INestApplication } from '@nestjs/common';
import { HttpError, HttpUploadApi, type FileDto, type PartSource, type PartTransport, type PutRequest } from '@s3up/core';
import { AppModule } from '../../apps/api/src/app.module';
import { loadConfig } from '../../apps/api/src/config';

export interface RunningApi {
  url: string;
  app: INestApplication;
  apiFor(userId: string): HttpUploadApi;
  close(): Promise<void>;
}

/** Boots the real Nest app in-process, wired to LocalStack through the environment. */
export async function startApi(): Promise<RunningApi> {
  const config = loadConfig({ ...process.env, PORT: '0', PART_SIZE_BYTES: String(16 * 1024 * 1024), SSE_POLL_MS: '250' });
  const app = await NestFactory.create(AppModule.register(config), { logger: ['error'] });
  await app.listen(0, '127.0.0.1');
  const url = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
  return { url, app, apiFor: (userId) => new HttpUploadApi({ baseUrl: url, userId }), close: () => app.close() };
}

export class NodeFileSource implements PartSource {
  private constructor(
    private readonly handle: FileHandle,
    readonly size: number,
  ) {}
  static async open(path: string): Promise<NodeFileSource> {
    const handle = await open(path, 'r');
    return new NodeFileSource(handle, (await handle.stat()).size);
  }
  async read(start: number, end: number): Promise<Uint8Array> {
    const buf = Buffer.alloc(end - start);
    const { bytesRead } = await this.handle.read(buf, 0, buf.length, start);
    return buf.subarray(0, bytesRead);
  }
  close() {
    return this.handle.close();
  }
}

/** PUTs parts to S3 with fetch, recording which part numbers were sent. */
export class FetchTransport implements PartTransport {
  readonly sentParts: number[] = [];
  async put(req: PutRequest): Promise<void> {
    this.sentParts.push(Number(new URL(req.url).searchParams.get('partNumber')));
    let res: Response;
    try {
      res = await fetch(req.url, { method: 'PUT', headers: req.headers, body: req.body as Uint8Array<ArrayBuffer>, signal: req.signal });
    } catch (err) {
      if ((err as Error).name === 'AbortError') throw err;
      throw new HttpError((err as Error).message);
    }
    if (!res.ok) throw new HttpError(`S3 PUT failed: ${res.status} ${await res.text()}`, res.status, res.status === 400 || res.status === 403 ? true : undefined);
    req.onProgress(req.body.byteLength);
  }
}

export async function waitForFile(
  api: HttpUploadApi,
  fileId: string,
  done: (f: FileDto) => boolean,
  timeoutMs = 240_000,
): Promise<FileDto> {
  const start = Date.now();
  for (;;) {
    const file = await api.getFile(fileId);
    if (done(file)) return file;
    if (Date.now() - start > timeoutMs) throw new Error(`Timed out waiting on ${fileId}; last status "${file.status}" ${file.error ?? ''}`);
    await new Promise((r) => setTimeout(r, 1000));
  }
}
