import { CanActivate, ExecutionContext, Inject, Injectable, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AUTHENTICATOR } from '../common/tokens';
import type { Authenticator, RequestHeaders } from './authenticator';

const PUBLIC = 'isPublic';
/** Marks a route that needs no authentication (health checks). */
export const Public = () => SetMetadata(PUBLIC, true);

export interface AuthedRequest {
  headers: RequestHeaders;
  userId?: string;
}

/** Runs on every route: authenticates the caller and attaches `userId` to the request. */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    @Inject(AUTHENTICATOR) private readonly authenticator: Authenticator,
    @Inject(Reflector) private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (this.reflector.getAllAndOverride<boolean>(PUBLIC, [context.getHandler(), context.getClass()])) return true;
    const req = context.switchToHttp().getRequest<AuthedRequest>();
    req.userId = await this.authenticator.authenticate(req.headers);
    return true;
  }
}
