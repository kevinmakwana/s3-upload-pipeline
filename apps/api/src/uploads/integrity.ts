import { createHash } from 'node:crypto';

export interface PartDigest {
  /** ETag as returned by S3 (quotes optional). For SSE-S3 parts this is the part's MD5. */
  etag: string;
  /** Base64 SHA-256 stored for the part. */
  sha256: string;
}

const stripQuotes = (s: string) => s.replace(/^"|"$/g, '');

/**
 * S3's multipart ETag: MD5 of the concatenated binary MD5s of every part, plus "-<parts>".
 * Recomputing it from ListParts lets us check what CompleteMultipartUpload really produced.
 */
export function expectedMultipartEtag(parts: readonly PartDigest[]): string {
  const concat = Buffer.concat(parts.map((p) => Buffer.from(stripQuotes(p.etag), 'hex')));
  return `${createHash('md5').update(concat).digest('hex')}-${parts.length}`;
}

/** The composite SHA-256 S3 reports for a multipart object: base64(sha256(concat(part sha256))) + "-N". */
export function expectedCompositeSha256(parts: readonly PartDigest[]): string {
  const concat = Buffer.concat(parts.map((p) => Buffer.from(p.sha256, 'base64')));
  return `${createHash('sha256').update(concat).digest('base64')}-${parts.length}`;
}

export function normalizeEtag(etag: string | undefined): string | undefined {
  return etag === undefined ? undefined : stripQuotes(etag);
}
