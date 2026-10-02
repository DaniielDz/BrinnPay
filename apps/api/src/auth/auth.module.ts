import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';

import { AuditLoggingCoreModule } from '../audit-logging/audit-logging-core.module';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { PasswordService } from './password.service';
import { AuthRateLimitGuard } from './rate-limit.guard';
import { AuthRateLimitService } from './rate-limit.service';
import { RefreshSessionService } from './refresh-session.service';
import { SessionAuthGuard } from './session-auth.guard';
import { TokenService } from './token.service';

/**
 * Authentication domain module (phase 3). Wired globally so the reusable
 * `SessionAuthGuard` and `TokenService` are injectable by all later
 * session-authenticated phases without re-importing.
 *
 * AuditLoggingCoreModule (phase 12 §5.2) supplies the audit capture port:
 * registration writes `user.registered` inside the registration transaction,
 * while login/login-failed/logout outcomes are recorded best-effort (D7) and
 * never alter the authentication result.
 */
@Global()
@Module({
  imports: [
    AuditLoggingCoreModule,
    JwtModule.registerAsync({
      global: true,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.getOrThrow<string>('jwt.secret'),
        signOptions: {
          expiresIn: `${config.getOrThrow<number>('jwt.accessTokenTtlSeconds')}s`,
        },
      }),
    }),
  ],
  controllers: [AuthController],
  providers: [
    AuthService,
    PasswordService,
    TokenService,
    RefreshSessionService,
    AuthRateLimitService,
    AuthRateLimitGuard,
    SessionAuthGuard,
  ],
  exports: [
    TokenService,
    SessionAuthGuard,
    RefreshSessionService,
    AuthRateLimitService,
    AuthRateLimitGuard,
  ],
})
export class AuthModule {}
