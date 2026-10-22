import { createHash } from 'node:crypto';
import { crc32, deflateSync } from 'node:zlib';

export const MiB = 1024 * 1024;

export interface TestFile {
  name: string;
  mimeType: string;
  buffer: Buffer;
  sha256: string;
}

export const sha256 = (data: Uint8Array): string => createHash('sha256').update(data).digest('hex');

/** Pseudo-random but repeatable bytes, so a failure can be reproduced with the same file. */
export function binaryFile(name: string, size: number, seed = 1): TestFile {
  const buffer = Buffer.alloc(size);
  let x = seed >>> 0 || 1;
  for (let i = 0; i < size; i++) {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    buffer[i] = x & 0xff;
  }
  return { name, mimeType: 'application/octet-stream', buffer, sha256: sha256(buffer) };
}

/** A plain RGB gradient PNG, small enough to upload as a single part. */
export function pngFile(name: string, width: number, height: number): TestFile {
  const chunk = (type: string, data: Buffer): Buffer => {
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8); // 8-bit RGB, no interlace
  const rows = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    const row = y * (width * 3 + 1);
    for (let x = 0; x < width; x++) rows.set([(x * 255) / width, (y * 255) / height, 128], row + 1 + x * 3);
  }
  const buffer = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(rows)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
  return { name, mimeType: 'image/png', buffer, sha256: sha256(buffer) };
}

export const asUpload = ({ name, mimeType, buffer }: TestFile) => ({ name, mimeType, buffer });
