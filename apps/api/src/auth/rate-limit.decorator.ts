import { SetMetadata } from '@nestjs/common';

export interface AuthRateLimitOptions {
  /** IP-scoped limit applied to the endpoint. */
  ipMax?: number;
  /** Account (email) scoped limit; applied alongside IP when set. */
  accountMax?: number;
}

/**
 * Declares a rate-limit profile for an auth endpoint. When omitted, the
 * default profile is IP-only. The guard reads the configured values from the
 * application config; these metadata flags only mark *kind* of throttling.
 */
export const AUTH_RATE_LIMIT_KEY = 'brinnpay:auth:rateLimit';

export type AuthRateLimitKind = 'read' | 'refresh' | 'session-creation' | 'none';

export function AuthRateLimit(kind: AuthRateLimitKind): MethodDecorator {
  return SetMetadata(AUTH_RATE_LIMIT_KEY, kind);
}