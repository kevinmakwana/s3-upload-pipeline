import type { FileDto } from '@s3up/core';
import { SseParser, watchFiles } from './sse';

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

describe('watchFiles', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  /** A response whose stream delivers `chunks`, then stays open until aborted, like a real fetch. */
  const streaming = (signal: AbortSignal | null | undefined, ...chunks: string[]) =>
    new Response(
      new ReadableStream({
        start(controller) {
          for (const c of chunks) controller.enqueue(new TextEncoder().encode(c));
          signal?.addEventListener('abort', () => controller.error(new DOMException('aborted', 'AbortError')));
        },
      }),
      { status: 200 },
    );

  async function runOnce(getHeaders: () => Record<string, string> | Promise<Record<string, string>>) {
    const seen: { url: string; headers: Record<string, string> }[] = [];
    const files: FileDto[][] = [];
    const abort = new AbortController();
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      seen.push({ url, headers: init.headers as Record<string, string> });
      return streaming(init.signal, 'event: files\ndata: {"files":[{"id":"f1"}]}\n\n');
    }) as unknown as typeof fetch;
    const done = watchFiles({
      baseUrl: 'http://api',
      getHeaders,
      onFiles: (f) => {
        files.push(f);
        abort.abort();
      },
      onState: () => undefined,
      signal: abort.signal,
    });
    await done;
    return { seen, files };
  }

  it('authenticates the stream with whatever the header provider returns (a bearer token)', async () => {
    const { seen, files } = await runOnce(async () => ({ authorization: 'Bearer t1' }));
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe('http://api/files/stream');
    expect(seen[0]!.headers).toEqual({ authorization: 'Bearer t1', accept: 'text/event-stream' });
    expect(files).toEqual([[{ id: 'f1' }]]);
  });

  it('works with the demo header too, and does not add any other identity', async () => {
    const { seen } = await runOnce(() => ({ 'x-user-id': 'demo-1' }));
    expect(seen[0]!.headers).toEqual({ 'x-user-id': 'demo-1', accept: 'text/event-stream' });
  });

  it('asks for headers again on every reconnect, so a refreshed token is used', async () => {
    jest.useFakeTimers();
    try {
      let n = 0;
      const tokens: (string | undefined)[] = [];
      const abort = new AbortController();
      globalThis.fetch = (async (_url: string, init: RequestInit) => {
        tokens.push((init.headers as Record<string, string>).authorization);
        if (tokens.length === 2) abort.abort();
        return new Response('nope', { status: 503 });
      }) as unknown as typeof fetch;
      const done = watchFiles({
        baseUrl: 'http://api',
        getHeaders: async () => ({ authorization: `Bearer t${++n}` }),
        onFiles: () => undefined,
        onState: () => undefined,
        signal: abort.signal,
      });
      await jest.advanceTimersByTimeAsync(5_000);
      await done;
      expect(tokens).toEqual(['Bearer t1', 'Bearer t2']);
    } finally {
      jest.useRealTimers();
    }
  });
});
