import type { FileDto } from '@s3up/core';

export interface SseMessage {
  event: string;
  data: string;
}

/** Incremental parser for text/event-stream. Feed it decoded chunks as they arrive. */
export class SseParser {
  private buffer = '';
  private event = 'message';
  private data: string[] = [];

  push(chunk: string): SseMessage[] {
    this.buffer += chunk;
    const out: SseMessage[] = [];
    let nl: number;
    while ((nl = this.buffer.search(/\r\n|\r|\n/)) !== -1) {
      const line = this.buffer.slice(0, nl);
      const sep = this.buffer.startsWith('\r\n', nl) ? 2 : 1;
      this.buffer = this.buffer.slice(nl + sep);
      if (line === '') {
        if (this.data.length) out.push({ event: this.event, data: this.data.join('\n') });
        this.event = 'message';
        this.data = [];
      } else if (!line.startsWith(':')) {
        const colon = line.indexOf(':');
        const field = colon === -1 ? line : line.slice(0, colon);
        const value = colon === -1 ? '' : line.slice(colon + 1).replace(/^ /, '');
        if (field === 'event') this.event = value;
        else if (field === 'data') this.data.push(value);
      }
    }
    return out;
  }
}

export type ConnectionState = 'connecting' | 'live' | 'reconnecting';

export interface WatchOptions {
  baseUrl: string;
  userId: string;
  onFiles(files: FileDto[]): void;
  onState(state: ConnectionState): void;
  signal: AbortSignal;
}

/**
 * Live file status over SSE. EventSource can't send the x-user-id header, so this reads the
 * stream with fetch. Reconnects with backoff; the server resends the full list on connect.
 */
export async function watchFiles({ baseUrl, userId, onFiles, onState, signal }: WatchOptions): Promise<void> {
  let attempt = 0;
  while (!signal.aborted) {
    onState(attempt === 0 ? 'connecting' : 'reconnecting');
    try {
      const res = await fetch(`${baseUrl}/files/stream`, { headers: { 'x-user-id': userId, accept: 'text/event-stream' }, signal });
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
      onState('live');
      attempt = 0;
      const parser = new SseParser();
      const decoder = new TextDecoder();
      const reader = res.body.getReader();
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        for (const msg of parser.push(decoder.decode(value, { stream: true }))) {
          if (msg.event === 'files') onFiles((JSON.parse(msg.data) as { files: FileDto[] }).files);
        }
      }
    } catch (err) {
      if (signal.aborted) return;
      void err;
    }
    if (signal.aborted) return;
    attempt++;
    onState('reconnecting');
    await new Promise((r) => setTimeout(r, Math.min(10_000, 500 * 2 ** Math.min(attempt, 5))));
  }
}
