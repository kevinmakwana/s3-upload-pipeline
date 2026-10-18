import { ArgumentsHost, Catch, HttpException, Inject } from '@nestjs/common';
import { BaseExceptionFilter } from '@nestjs/core';
import type { Request } from 'express';
import type { AuthedRequest } from '../auth/auth.guard';
import { JsonLogger, errorFields } from './logger';
import { pathOf } from './request-logging';
import { LOGGER } from './tokens';

/**
 * Logs what went wrong (with its stack) whenever a request ends in a 5xx, tied to the request id
 * the caller also received, then lets Nest answer exactly as it would have: unexpected errors
 * become a generic 500 that reveals nothing. Ordinary 4xx responses are not failures and are only
 * seen in the request log.
 */
@Catch()
export class LoggingExceptionFilter extends BaseExceptionFilter {
  constructor(@Inject(LOGGER) private readonly logger: JsonLogger) {
    super();
  }

  override catch(exception: unknown, host: ArgumentsHost): void {
    const status = exception instanceof HttpException ? exception.getStatus() : 500;
    if (status >= 500 && host.getType() === 'http') {
      const req = host.switchToHttp().getRequest<Request & AuthedRequest>();
      this.logger.event('error', 'unhandled error', {
        requestId: req.requestId,
        method: req.method,
        path: pathOf(req),
        userId: req.userId ?? null,
        status,
        ...errorFields(exception),
      });
    }
    super.catch(exception, host);
  }
}
