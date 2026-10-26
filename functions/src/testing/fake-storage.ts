import { Readable } from 'node:stream';
import type { ObjectStorage } from '../process-upload/processor';

/** An in-memory bucket for the worker's tests. `failStream` makes the next N reads fail, like a dropped connection. */
export class FakeStorage implements ObjectStorage {
  objects = new Map<string, Buffer>();
  thumbnails = new Map<string, Buffer>();
  streamCalls = 0;
  failStream = 0;
  async head(key: string) {
    const o = this.objects.get(key);
    if (!o) throw new Error('NoSuchKey');
    return { size: o.length };
  }
  async readHead(key: string, _v: string | undefined, length: number) {
    return this.objects.get(key)!.subarray(0, length);
  }
  async stream(key: string) {
    this.streamCalls++;
    if (this.failStream > 0) {
      this.failStream--;
      throw new Error('connection reset');
    }
    return Readable.from([this.objects.get(key)!]);
  }
  async readAll(key: string) {
    return this.objects.get(key)!;
  }
  async putThumbnail(key: string, body: Buffer) {
    this.thumbnails.set(key, body);
  }
}
