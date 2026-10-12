import { formatBytes, formatDuration, formatRate, shortHash } from './format';

describe('format', () => {
  it('formats bytes in binary units', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(5 * 1024 ** 3)).toBe('5.0 GB');
    expect(formatBytes(123 * 1024 ** 2)).toBe('123 MB');
    expect(formatBytes(-1)).toBe('–');
  });
  it('formats rates and durations', () => {
    expect(formatRate(0)).toBe('–');
    expect(formatRate(2 * 1024 ** 2)).toBe('2.0 MB/s');
    expect(formatDuration(undefined)).toBe('–');
    expect(formatDuration(42)).toBe('42s');
    expect(formatDuration(125)).toBe('2m 05s');
    expect(formatDuration(3 * 3600 + 7 * 60)).toBe('3h 07m');
  });
  it('shortens hashes', () => {
    expect(shortHash('a'.repeat(64))).toBe('aaaaaaaa…aaaaaa');
  });
});
