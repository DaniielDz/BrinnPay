import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Response } from 'express';

import { ApiError } from '../common/errors/api-error';
import { ErrorCode } from '../common/errors/error-code';
import type { BrinnPayConfig } from '../config/configuration';
import { AuthService } from './auth.service';
import { clearRefreshCookie, refreshCookieSpec, setRefreshCookie } from './cookie';
import { CurrentUser, type AuthenticatedRequest, type PublicUser } from './current-user';
import { LoginDto } from './dto/login.dto';
import { RegisterDto } from './dto/register.dto';
import { AuthRateLimit } from './rate-limit.decorator';
import { AuthRateLimitGuard } from './rate-limit.guard';
import { SessionAuthGuard } from './session-auth.guard';

/**
 * Authentication surface (phase 3 §4.2). All endpoints live under
 * `/api/v1/auth`, are rate limited (D7), and follow the canonical envelope.
 * The refresh token is delivered exclusively as an `HttpOnly` cookie and never
 * appears in a JSON body.
 */
@Controller('auth')
@UseGuards(AuthRateLimitGuard)
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly config: ConfigService,
  ) {}

  private get cookies() {
    return refreshCookieSpec(this.config.getOrThrow<BrinnPayConfig['auth']>('auth'));
  }

  @Post('register')
  @HttpCode(HttpStatus.CREATED)
  @AuthRateLimit('session-creation')
  async register(
    @Body() dto: RegisterDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AuthSessionPayload> {
    const session = await this.auth.register(dto);
    setRefreshCookie(res, this.cookies, session.refreshToken);
    return {
      access_token: session.accessToken,
      token_type: 'Bearer',
      expires_in: session.expiresIn,
      user: session.user,
    };
  }

  @Post('login')
  @HttpCode(HttpStatus.OK)
  @AuthRateLimit('session-creation')
  async login(
    @Body() dto: LoginDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AuthSessionPayload> {
    const session = await this.auth.login(dto);
    setRefreshCookie(res, this.cookies, session.refreshToken);
    return {
      access_token: session.accessToken,
      token_type: 'Bearer',
      expires_in: session.expiresIn,
      user: session.user,
    };
  }

  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @AuthRateLimit('refresh')
  async refresh(
    @Req() req: AuthenticatedRequest,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AccessTokenPayload> {
    const token = this.readRefreshToken(req);
    if (!token) {
      this.invalidateWithResponse(res);
    }

    try {
      const result = await this.auth.refresh(token);
      setRefreshCookie(res, this.cookies, result.refreshToken);
      return {
        access_token: result.accessToken,
        token_type: 'Bearer',
        expires_in: result.expiresIn,
      };
    } catch (error) {
      if (error instanceof ApiError) {
        clearRefreshCookie(res, this.cookies);
      }
      throw error;
    }
  }

  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  @AuthRateLimit('refresh')
  async logout(
    @Req() req: AuthenticatedRequest,
    @Res({ passthrough: true }) res: Response,
  ): Promise<void> {
    const token = this.readRefreshToken(req);
    if (token) {
      await this.auth.logout(token);
    }
    // Idempotent (D9): the cookie is always cleared and 204 returned whether
    // or not a valid session was present.
    clearRefreshCookie(res, this.cookies);
  }

  @Get('me')
  @UseGuards(SessionAuthGuard)
  @AuthRateLimit('read')
  me(@CurrentUser() user: PublicUser): PublicUser {
    return user;
  }

  private readRefreshToken(req: AuthenticatedRequest): string | undefined {
    return req.cookies?.[this.cookies.name];
  }

  private invalidateWithResponse(res: Response): never {
    clearRefreshCookie(res, this.cookies);
    throw new ApiError(ErrorCode.UNAUTHENTICATED, 'Session invalid or expired', 401);
  }
}

export interface AuthSessionPayload {
  access_token: string;
  token_type: 'Bearer';
  expires_in: number;
  user: PublicUser;
}

export interface AccessTokenPayload {
  access_token: string;
  token_type: 'Bearer';
  expires_in: number;
}
