import { createParamDecorator, ExecutionContext } from '@nestjs/common';

import type { User as PrismaUser } from '../../generated/prisma/client';

/**
 * Public representation of a user account: exactly the `User` schema of the
 * OpenAPI contract (`id`, `email`, `name`, `created_at`, `updated_at` — JSON
 * fields are `snake_case` per the API conventions). Never includes
 * `password_hash` or any other internal fields. All user projections in auth
 * responses and guard-loaded requests use this shape.
 */
export interface PublicUser {
  id: string;
  email: string;
  name: string | null;
  created_at: Date;
  updated_at: Date;
}

export function toPublicUser(user: PrismaUser): PublicUser {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    created_at: user.createdAt,
    updated_at: user.updatedAt,
  };
}

export type AuthUser = PublicUser;

export interface AuthenticatedRequest<Body = unknown> {
  authUser?: AuthUser;
  cookies?: Record<string, string>;
  ip?: string;
  body?: Body;
  headers?: Record<string, string | string[] | undefined>;
  // Satisfies structural compatibility with express.Request where needed.
  [key: string]: unknown;
}

/**
 * Returns the user attached by `SessionAuthGuard`. The presence of `authUser`
 * is guaranteed only inside endpoints guarded by `@UseGuards(SessionAuthGuard)`
 * on a request authenticated via bearer JWT.
 */
export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthUser => {
    const request = ctx.switchToHttp().getRequest<AuthenticatedRequest>();
    if (!request.authUser) {
      // Programming error: must only be used behind SessionAuthGuard. Throwing
      // here keeps misuse loud instead of silent.
      throw new Error('CurrentUser used outside an authenticated session');
    }
    return request.authUser;
  },
);