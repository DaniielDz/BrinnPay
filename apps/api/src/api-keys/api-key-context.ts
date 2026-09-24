import { createParamDecorator, ExecutionContext } from '@nestjs/common';

import type { ApiKey as PrismaApiKey } from '../../generated/prisma/client';
import type { AuthenticatedRequest } from '../auth/current-user';
import type { Environment } from '../projects/environment';

/**
 * The authentication scope derived from a validated API key (phase 5 §4.5,
 * D4): exactly one (project, environment). Phase 6+ resource routes consume
 * this context to scope every query and to reject payload/query environments
 * that do not match the key's environment.
 */
export interface ApiKeyContext {
  key_id: string;
  project_id: string;
  environment: Environment;
}

export function toApiKeyContext(key: Pick<PrismaApiKey, 'id' | 'projectId' | 'environment'>): ApiKeyContext {
  return {
    key_id: key.id,
    project_id: key.projectId,
    environment: key.environment as Environment,
  };
}

/**
 * Returns the API-key scope attached by `ApiKeyAuthGuard`. Presence is
 * guaranteed only behind `@UseGuards(ApiKeyAuthGuard)`.
 */
export const CurrentApiKey = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): ApiKeyContext => {
    const request = ctx.switchToHttp().getRequest<AuthenticatedRequest>();
    const apiKey = request.apiKey as ApiKeyContext | undefined;
    if (!apiKey) {
      // Programming error: must only be used behind ApiKeyAuthGuard.
      throw new Error('CurrentApiKey used outside an API-key-authenticated guard');
    }
    return apiKey;
  },
);