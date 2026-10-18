import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import type { AuthedRequest } from '../auth/auth.guard';
import type { JsonLogger } from './logger';

/** What we accept as a caller-supplied request id: short, boring characters only. */
const SAFE_REQUEST_ID = /^[A-Za-z0-9._-]{8,64}$/;
const MAX_PATH = 200;

/** The path without its query string: cursors and other parameters have no business in the logs. */
export function pathOf(req: Pick<Request, 'originalUrl' | 'url'>): string {
  return (req.originalUrl ?? req.url ?? '').split('?')[0]!.slice(0, MAX_PATH);
}

/**
 * Gives every request an id (kept from `x-request-id` when it looks sane, so a call can be
 * followed across systems), returns it in the response, and writes one log line when the
 * response is done. Headers and bodies are never logged. It runs before everything else, so
 * requests that are throttled or fail authentication are logged too.
 */
export function requestLogging(logger: JsonLogger) {
  return (req: Request & AuthedRequest, res: Response, next: NextFunction): void => {
    const supplied = req.headers['x-request-id'];
    const requestId = typeof supplied === 'string' && SAFE_REQUEST_ID.test(supplied) ? supplied : randomUUID();
    req.requestId = requestId;
    res.setHeader('x-request-id', requestId);
    const started = process.hrtime.bigint();

    // "close" fires whether the response finished or the client went away first.
    res.on('close', () => {
      const status = res.statusCode;
      const path = pathOf(req);
      if (status < 400 && (path === '/health' || req.method === 'OPTIONS')) return; // constant background noise
      logger.event(status >= 500 ? 'error' : status >= 400 ? 'warn' : 'info', 'request', {
        requestId,
        method: req.method,
        path,
        status,
        durationMs: Math.round(Number(process.hrtime.bigint() - started) / 1e4) / 100,
        userId: req.userId ?? null,
        ip: req.ip,
        ...(res.writableFinished ? {} : { aborted: true }),
      });
    });
    next();
  };
}
