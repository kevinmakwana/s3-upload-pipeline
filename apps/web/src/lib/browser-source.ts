import type { PartSource } from '@s3up/core';

/** Reads parts straight from the File on disk; only one part at a time per worker is in memory. */
export class BrowserFileSource implements PartSource {
  readonly size: number;
  constructor(private readonly file: File) {
    this.size = file.size;
  }
  async read(start: number, end: number): Promise<Uint8Array> {
    return new Uint8Array(await this.file.slice(start, end).arrayBuffer());
  }
}
