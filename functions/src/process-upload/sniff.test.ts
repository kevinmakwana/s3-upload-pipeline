import { matchesDeclaredType, sniffType } from './sniff';

const bytes = (...b: number[]) => Uint8Array.from(b);
const text = (s: string, offset = 0) => Uint8Array.from([...Array(offset).fill(0), ...Buffer.from(s, 'latin1')]);

describe('sniffType', () => {
  it('recognises common signatures', () => {
    expect(sniffType(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0))).toBe('image/png');
    expect(sniffType(bytes(0xff, 0xd8, 0xff, 0xe0))).toBe('image/jpeg');
    expect(sniffType(text('GIF89a'))).toBe('image/gif');
    expect(sniffType(text('RIFF\0\0\0\0WEBPVP8 '))).toBe('image/webp');
    expect(sniffType(text('%PDF-1.7'))).toBe('application/pdf');
    expect(sniffType(bytes(0x50, 0x4b, 0x03, 0x04, 0))).toBe('application/zip');
    expect(sniffType(bytes(0x1f, 0x8b, 8))).toBe('application/gzip');
    expect(sniffType(text('\0\0\0\x18ftypisom'))).toBe('video/mp4');
    expect(sniffType(text('\0\0\0\x14ftypqt  '))).toBe('video/quicktime');
    expect(sniffType(text('ustar', 257))).toBe('application/x-tar');
  });
  it('returns undefined for unknown data', () => {
    expect(sniffType(bytes(1, 2, 3, 4))).toBeUndefined();
    expect(sniffType(new Uint8Array())).toBeUndefined();
  });
});

describe('matchesDeclaredType', () => {
  it('accepts agreement, unknown content, and generic octet-stream', () => {
    expect(matchesDeclaredType('image/png', 'image/png')).toBe(true);
    expect(matchesDeclaredType('text/csv', undefined)).toBe(true);
    expect(matchesDeclaredType('application/octet-stream', 'application/zip')).toBe(true);
    expect(matchesDeclaredType('video/mp4', 'video/quicktime')).toBe(true);
  });
  it('rejects disguised content', () => {
    expect(matchesDeclaredType('image/png', 'application/zip')).toBe(false);
    expect(matchesDeclaredType('text/csv', 'application/pdf')).toBe(false);
  });
});
