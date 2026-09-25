import { createParamDecorator, ExecutionContext } from '@nestjs/common';

import type { AuthenticatedRequest } from '../auth/current-user';
import type { ApiKeyContext } from '../api-keys/api-key-context';
import type { Environment } from '../projects/environment';
import type { ResolvedProject } from '../projects/request-project';

/**
 * The resolved request scope for the customer routes (phase 6 §4.3, D8).
 * Exactly one of the two modes is attached by `CustomersAccessGuard`:
 *
 * - **API-key mode:** the key's (project, environment) scope. The path
 *   `project_id` already equals the key's project (the guard verified it with
 *   404 non-disclosure); no role check applies (D6).
 * - **Session mode:** the authenticated user's resolved project (membership
 *   in the owning organization + the route's capability were verified by the
 *   guard with the 404/403 semantics of phases 4/5).
 */
export interface ApiKeyModeScope {
  mode: 'api_key';
  key: ApiKeyContext;
  project_id: string;
  environment: Environment;
}

export interface SessionModeScope {
  mode: 'session';
  project: ResolvedProject;
  project_id: string;
}

export type CustomersScope = ApiKeyModeScope | SessionModeScope;

/**
 * Returns the scope attached by `CustomersAccessGuard`. Presence is guaranteed
 * only behind `@UseGuards(CustomersAccessGuard)`.
 */
export const CustomersScope = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): CustomersScope => {
    const request = ctx.switchToHttp().getRequest<AuthenticatedRequest>();
    const apiKey = request.apiKey as ApiKeyContext | undefined;
    const project = request.project as ResolvedProject | undefined;

    if (apiKey && project) {
      throw new Error('CustomersAccessGuard attached both API-key and session scopes');
    }
    if (apiKey) {
      return {
        mode: 'api_key',
        key: apiKey,
        project_id: apiKey.project_id,
        environment: apiKey.environment,
      };
    }
    if (project) {
      return {
        mode: 'session',
        project,
        project_id: project.project_id,
      };
    }
    // Programming error: must only be used behind CustomersAccessGuard.
    throw new Error('CustomersScope used outside the customers access guard');
  },
);