import type { LoggerService } from '@nestjs/common';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export type LogLevelSetting = LogLevel | 'silent';
export const LOG_LEVELS: readonly LogLevelSetting[] = ['debug', 'info', 'warn', 'error', 'silent'];

const RANK: Record<LogLevelSetting, number> = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };

export type LogFields = Record<string, unknown>;

/**
 * One JSON object per line on stdout, the same shape as the worker's logs, so CloudWatch Logs
 * Insights (or anything else) can filter on fields. It is also handed to Nest, so the framework's
 * own messages come out in the same format. JSON encoding escapes newlines and quotes, so text
 * from a request can never forge a second log line.
 */
export class JsonLogger implements LoggerService {
  constructor(
    private readonly level: LogLevelSetting = 'info',
    private readonly write: (line: string) => void = (line) => console.log(line),
  ) {}

  event(level: LogLevel, message: string, fields: LogFields = {}): void {
    if (RANK[level] < RANK[this.level]) return;
    let line: string;
    try {
      line = JSON.stringify({ level, time: new Date().toISOString(), message, ...fields });
    } catch {
      line = JSON.stringify({ level, time: new Date().toISOString(), message, logError: 'fields could not be serialised' });
    }
    this.write(line);
  }

  // --- Nest's LoggerService. Nest passes the context name last, and for errors the stack before it.
  log(message: unknown, ...params: unknown[]) {
    this.fromNest('info', message, params);
  }
  warn(message: unknown, ...params: unknown[]) {
    this.fromNest('warn', message, params);
  }
  error(message: unknown, ...params: unknown[]) {
    this.fromNest('error', message, params);
  }
  fatal(message: unknown, ...params: unknown[]) {
    this.fromNest('error', message, params);
  }
  debug(message: unknown, ...params: unknown[]) {
    this.fromNest('debug', message, params);
  }
  verbose(message: unknown, ...params: unknown[]) {
    this.fromNest('debug', message, params);
  }

  private fromNest(level: LogLevel, message: unknown, params: unknown[]): void {
    const last = params.at(-1);
    const context = typeof last === 'string' ? last : undefined;
    const rest = context === undefined ? params : params.slice(0, -1);
    const stack = message instanceof Error ? message.stack : rest.find((p): p is string => typeof p === 'string');
    this.event(level, textOf(message), { ...(context ? { context } : {}), ...(stack ? { stack } : {}) });
  }
}

function textOf(message: unknown): string {
  if (typeof message === 'string') return message;
  if (message instanceof Error) return message.message;
  try {
    return JSON.stringify(message) ?? String(message);
  } catch {
    return String(message);
  }
}

/** Fields describing a thrown value. Only real Errors and plain strings are echoed back. */
export function errorFields(err: unknown): LogFields {
  if (err instanceof Error) return { errorName: err.name, errorMessage: err.message, stack: err.stack };
  if (typeof err === 'string') return { errorName: 'NonError', errorMessage: err.slice(0, 500) };
  return { errorName: 'NonError', errorMessage: 'Non-error value thrown' };
}
