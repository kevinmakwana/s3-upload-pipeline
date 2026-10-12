import { createHash } from 'node:crypto';
import { UnauthorizedException } from '@nestjs/common';
import { isValidUserId } from '@s3up/core';
import { jwtVerify, type JWTVerifyGetKey } from 'jose';

export type RequestHeaders = Record<string, string | string[] | undefined>;

/** Turns request headers into the caller's user id, or throws 401. */
export interface Authenticator {
  authenticate(headers: RequestHeaders): Promise<string>;
}

const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

/**
 * Demo mode: the caller names itself in `x-user-id`. This is NOT security. It exists so the
 * LocalStack demo needs no identity provider, and the API refuses to start with it in production
 * unless ALLOW_INSECURE_DEMO_AUTH=true.
 */
export class HeaderAuthenticator implements Authenticator {
  async authenticate(headers: RequestHeaders): Promise<string> {
    const userId = first(headers['x-user-id']);
    if (!userId || !isValidUserId(userId)) throw new UnauthorizedException('Missing or invalid x-user-id header');
    return userId;
  }
}

export interface JwtOptions {
  issuer: string;
  audience: string;
  /** Allowed clock drift between us and the issuer, in seconds. */
  clockToleranceSeconds?: number;
}

/** Asymmetric algorithms only: a shared-secret (HS*) or "none" token can never be accepted. */
const ALGORITHMS = ['RS256', 'RS384', 'RS512', 'PS256', 'PS384', 'PS512', 'ES256', 'ES384', 'ES512', 'EdDSA'];

/**
 * Real authentication: verifies a bearer JWT's signature (against the issuer's JWKS), issuer,
 * audience and expiry. The user id is derived from issuer + subject, so it is always safe to use
 * in an S3 key prefix whatever characters the identity provider puts in `sub`.
 */
export class JwtAuthenticator implements Authenticator {
  constructor(
    private readonly keys: JWTVerifyGetKey,
    private readonly options: JwtOptions,
  ) {}

  async authenticate(headers: RequestHeaders): Promise<string> {
    const header = first(headers.authorization);
    const match = header?.match(/^Bearer\s+([\w-]+\.[\w-]+\.[\w-]+)$/i);
    if (!match) throw new UnauthorizedException('Missing bearer token');
    try {
      const { payload } = await jwtVerify(match[1]!, this.keys, {
        issuer: this.options.issuer,
        audience: this.options.audience,
        algorithms: ALGORITHMS,
        clockTolerance: this.options.clockToleranceSeconds ?? 5,
        requiredClaims: ['sub', 'exp'],
      });
      return userIdFor(this.options.issuer, payload.sub!);
    } catch {
      // Never say why (expired, wrong audience, bad signature): that only helps an attacker.
      throw new UnauthorizedException('Invalid or expired token');
    }
  }
}

export function userIdFor(issuer: string, subject: string): string {
  return `u-${createHash('sha256').update(`${issuer}|${subject}`).digest('hex').slice(0, 40)}`;
}
