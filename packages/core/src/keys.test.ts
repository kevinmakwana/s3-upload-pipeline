import { buildObjectKey, parseObjectKey, sanitizeFileName } from './keys';
import { validateUpload } from './validation';
import { GiB } from './limits';

const fileId = '3f2b8c1e-8d4a-4b6e-9f10-2a7c5d9e1b34';

describe('object keys', () => {
  it('scopes every key to the user prefix and round-trips', () => {
    const key = buildObjectKey('alice', fileId, 'My Holiday (1).JPG');
    expect(key).toBe(`uploads/alice/${fileId}/My_Holiday_1_.JPG`);
    expect(parseObjectKey(key)).toEqual({ userId: 'alice', fileId, fileName: 'My_Holiday_1_.JPG' });
  });

  it('cannot be tricked out of the prefix by the file name', () => {
    expect(sanitizeFileName('../../etc/passwd')).toBe('passwd');
    expect(sanitizeFileName('..\\..\\x.png')).toBe('x.png');
    expect(buildObjectKey('alice', fileId, '../bob/x.png')).toBe(`uploads/alice/${fileId}/x.png`);
  });

  it('rejects hostile user ids', () => {
    expect(() => buildObjectKey('../bob', fileId, 'a.png')).toThrow();
    expect(() => buildObjectKey('a/b', fileId, 'a.png')).toThrow();
    expect(() => buildObjectKey('alice', 'not-a-uuid', 'a.png')).toThrow();
  });

  it('refuses to parse keys outside the layout', () => {
    expect(parseObjectKey('thumbnails/alice/x.jpg')).toBeUndefined();
    expect(parseObjectKey(`uploads/alice/${fileId}`)).toBeUndefined();
    expect(parseObjectKey(`uploads/alice/${fileId}/a/b`)).toBeUndefined();
  });
});

describe('validateUpload', () => {
  it('accepts a normal file', () => {
    expect(validateUpload({ fileName: 'clip.mp4', fileSize: 5 * GiB, contentType: 'video/mp4' })).toEqual([]);
  });
  it('rejects oversize, empty, unknown types and extension mismatches', () => {
    expect(validateUpload({ fileName: 'a.mp4', fileSize: 21 * GiB, contentType: 'video/mp4' })).toHaveLength(1);
    expect(validateUpload({ fileName: 'a.mp4', fileSize: 0, contentType: 'video/mp4' })).toHaveLength(1);
    expect(validateUpload({ fileName: 'a.exe', fileSize: 10, contentType: 'application/x-msdownload' })).toHaveLength(1);
    expect(validateUpload({ fileName: 'a.exe', fileSize: 10, contentType: 'video/mp4' })).toHaveLength(1);
    expect(validateUpload({ fileName: 'noext', fileSize: 10, contentType: 'video/mp4' })).toHaveLength(1);
  });
  it('honours custom rules', () => {
    const rules = { maxFileSize: 100, allowedTypes: { 'text/plain': ['txt'] } };
    expect(validateUpload({ fileName: 'a.txt', fileSize: 101, contentType: 'text/plain' }, rules)).toHaveLength(1);
    expect(validateUpload({ fileName: 'a.txt', fileSize: 100, contentType: 'text/plain' }, rules)).toEqual([]);
  });
});
