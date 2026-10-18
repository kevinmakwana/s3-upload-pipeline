import { ExecutionContext, Injectable } from '@nestjs/common';
import { ThrottlerGuard, type ThrottlerLimitDetail } from '@nestjs/throttler';

const first = (v: unknown): string | undefined => (Array.isArray(v) ? v[0] : (v as string | undefined));

/**
 * Who a request is, for rate limiting, before it has been authenticated: the credential it
 * presents (bearer token or demo user id), else its address. Per-credential limits keep one user
 * from using up another's budget; the per-address limit alongside catches floods of bogus
 * credentials. The throttler hashes this into its storage key, so tokens are not kept around.
 */
export function callerKey(req: Record<string, any>): string {
  const credential = first(req.headers?.authorization) ?? first(req.headers?.['x-user-id']);
  return credential ? `credential:${credential}` : `ip:${req.ip}`;
}

/** The stock guard, plus the standard `Retry-After` header (it only sets one per named throttler). */
@Injectable()
export class RetryAfterThrottlerGuard extends ThrottlerGuard {
  protected override async throwThrottlingException(context: ExecutionContext, detail: ThrottlerLimitDetail): Promise<void> {
    const { res } = this.getRequestResponse(context);
    const seconds = Math.max(1, Math.ceil(detail.isBlocked ? detail.timeToBlockExpire : detail.timeToExpire));
    this.setResponseHeader(res, 'Retry-After', seconds);
    return super.throwThrottlingException(context, detail);
  }
}
