import { attachmentDisposition } from './content-disposition';

describe('attachmentDisposition', () => {
  it('forces a download and names the file', () => {
    expect(attachmentDisposition('report.pdf')).toBe(`attachment; filename="report.pdf"; filename*=UTF-8''report.pdf`);
  });

  it('keeps non-ASCII names intact in filename* and gives old clients an ASCII fallback', () => {
    const header = attachmentDisposition('résumé 2024.pdf');
    expect(header).toContain('filename="r_sum_ 2024.pdf"');
    expect(header).toContain(`filename*=UTF-8''r%C3%A9sum%C3%A9%202024.pdf`);
  });

  it('cannot be used to inject headers or break out of the quoted value', () => {
    const header = attachmentDisposition('a"b\\c\r\nSet-Cookie: x=1.txt');
    expect(header).not.toMatch(/[\r\n]/);
    const quoted = /filename="([^"]*)"/.exec(header)![1]!;
    expect(quoted).not.toMatch(/["\\]/);
    expect(header.startsWith('attachment;')).toBe(true);
  });

  it('percent-encodes the characters RFC 5987 does not allow raw', () => {
    expect(attachmentDisposition("it's (1)*.txt")).toContain(`filename*=UTF-8''it%27s%20%281%29%2A.txt`);
  });

  it('survives a lone surrogate instead of throwing', () => {
    expect(() => attachmentDisposition('bad\ud800name.txt')).not.toThrow();
  });
});
