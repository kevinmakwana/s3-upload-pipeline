import { SseParser } from './sse';

describe('SseParser', () => {
  it('parses events split across arbitrary chunks', () => {
    const p = new SseParser();
    expect(p.push('event: files\nda')).toEqual([]);
    expect(p.push('ta: {"files":[]}\n\nevent: ping\ndata: {}\n')).toEqual([{ event: 'files', data: '{"files":[]}' }]);
    expect(p.push('\n')).toEqual([{ event: 'ping', data: '{}' }]);
  });
  it('joins multi-line data, handles CRLF, ignores comments and defaults the event name', () => {
    const p = new SseParser();
    expect(p.push(': keepalive\r\ndata: a\r\ndata: b\r\n\r\n')).toEqual([{ event: 'message', data: 'a\nb' }]);
  });
  it('emits nothing for blocks without data', () => {
    expect(new SseParser().push('event: x\n\n')).toEqual([]);
  });
});
