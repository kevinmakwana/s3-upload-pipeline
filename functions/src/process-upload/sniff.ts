const ascii = (b: Uint8Array, start: number, end: number) => Buffer.from(b.subarray(start, end)).toString('latin1');
const startsWith = (b: Uint8Array, bytes: number[]) => bytes.every((v, i) => b[i] === v);

/** Content type from magic bytes. Returns undefined when nothing known matches. */
export function sniffType(head: Uint8Array): string | undefined {
  if (startsWith(head, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (startsWith(head, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (ascii(head, 0, 4) === 'GIF8') return 'image/gif';
  if (ascii(head, 0, 4) === 'RIFF' && ascii(head, 8, 12) === 'WEBP') return 'image/webp';
  if (ascii(head, 0, 5) === '%PDF-') return 'application/pdf';
  if (startsWith(head, [0x50, 0x4b, 0x03, 0x04]) || startsWith(head, [0x50, 0x4b, 0x05, 0x06])) return 'application/zip';
  if (startsWith(head, [0x1f, 0x8b])) return 'application/gzip';
  if (ascii(head, 4, 8) === 'ftyp') return ascii(head, 8, 12) === 'qt  ' ? 'video/quicktime' : 'video/mp4';
  if (ascii(head, 257, 262) === 'ustar') return 'application/x-tar';
  return undefined;
}

const VIDEO = new Set(['video/mp4', 'video/quicktime']);

/**
 * Does what the bytes look like agree with what the client declared?
 * Generic octet-stream is accepted as-is; text types must not look like a known binary format.
 */
export function matchesDeclaredType(declared: string, detected: string | undefined): boolean {
  if (declared === 'application/octet-stream' || detected === undefined) return true;
  if (declared === detected) return true;
  return VIDEO.has(declared) && VIDEO.has(detected);
}
