import { UnauthorizedException, createParamDecorator, type ExecutionContext } from '@nestjs/common';
import { isValidUserId } from '@s3up/core';

/**
 * Demo authentication: the caller names itself in `x-user-id`. This is deliberately a thin
 * seam, not security: in a real deployment replace it with a JWT/OIDC guard that yields the
 * same `userId`. Everything downstream (key prefixes, ownership checks) already keys off it.
 */
export const CurrentUser = createParamDecorator((_data: unknown, ctx: ExecutionContext): string => {
  const req = ctx.switchToHttp().getRequest<{ headers: Record<string, string | string[] | undefined> }>();
  const header = req.headers['x-user-id'];
  const userId = Array.isArray(header) ? header[0] : header;
  if (!userId || !isValidUserId(userId)) {
    throw new UnauthorizedException('Missing or invalid x-user-id header');
  }
  return userId;
});
