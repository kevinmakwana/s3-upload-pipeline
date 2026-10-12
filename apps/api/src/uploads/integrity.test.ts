import { createHash } from 'node:crypto';
import { expectedCompositeSha256, expectedMultipartEtag, normalizeEtag } from './integrity';

const md5 = (b: Buffer | string) => createHash('md5').update(b).digest();
const sha = (b: Buffer | string) => createHash('sha256').update(b).digest();

describe('integrity', () => {
  const chunks = [Buffer.from('part one'), Buffer.from('part two'), Buffer.from('3')];
  const parts = chunks.map((c) => ({ etag: `"${md5(c).toString('hex')}"`, sha256: sha(c).toString('base64') }));

  it('computes the S3 multipart ETag (md5 of part md5s, plus part count)', () => {
    const expected = createHash('md5').update(Buffer.concat(chunks.map(md5))).digest('hex');
    expect(expectedMultipartEtag(parts)).toBe(`${expected}-3`);
  });

  it('is order sensitive and ignores quoting', () => {
    const swapped = [parts[1]!, parts[0]!, parts[2]!];
    expect(expectedMultipartEtag(swapped)).not.toBe(expectedMultipartEtag(parts));
    expect(expectedMultipartEtag(parts.map((p) => ({ ...p, etag: p.etag.replaceAll('"', '') })))).toBe(expectedMultipartEtag(parts));
  });

  it('computes the composite SHA-256 S3 reports for multipart objects', () => {
    const expected = createHash('sha256').update(Buffer.concat(chunks.map(sha))).digest('base64');
    expect(expectedCompositeSha256(parts)).toBe(`${expected}-3`);
  });

  it('normalizes ETags', () => {
    expect(normalizeEtag('"abc-2"')).toBe('abc-2');
    expect(normalizeEtag(undefined)).toBeUndefined();
  });
});
