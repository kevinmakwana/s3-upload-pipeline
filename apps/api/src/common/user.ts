import { UnauthorizedException, createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { AuthedRequest } from '../auth/auth.guard';

/** The authenticated caller's user id, set by AuthGuard. Everything downstream keys off it. */
export const CurrentUser = createParamDecorator((_data: unknown, ctx: ExecutionContext): string => {
  const userId = ctx.switchToHttp().getRequest<AuthedRequest>().userId;
  if (!userId) throw new UnauthorizedException();
  return userId;
});
