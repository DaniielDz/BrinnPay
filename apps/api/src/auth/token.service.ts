import { Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';

/**
 * Access-token issuance and validation (D1). Tokens are signed JWTs (HS256)
 * with a server-held secret, carrying at minimum `sub` (user UUIDv7), `iat`
 * and `exp`. Tokens are opaque to clients; claims are kept minimal.
 */
@Injectable()
export class TokenService {
  constructor(private readonly jwt: JwtService) {}

  signAccessToken(userId: string): string {
    return this.jwt.sign({ sub: userId });
  }

  /**
   * Verifies signature and expiry and returns the subject. Any malformed,
   * expired, wrongly-signed, or structurally-invalid token is reported as
   * `null`; the caller maps it to the canonical 401 response.
   */
  verifyAccessToken(token: string): { sub: string } | null {
    try {
      const claims = this.jwt.verify<{ sub?: unknown }>(token);
      if (typeof claims?.sub !== 'string' || claims.sub.length === 0) {
        return null;
      }
      return { sub: claims.sub };
    } catch {
      return null;
    }
  }
}