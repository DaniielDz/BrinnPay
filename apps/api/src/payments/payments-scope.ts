import { createParamDecorator, ExecutionContext } from '@nestjs/common';

import type { ApiKeyContext } from '../api-keys/api-key-context';
import type { AuthenticatedRequest } from '../auth/current-user';
import type { Environment } from '../projects/environment';
import type { ResolvedProject } from '../projects/request-project';

/**
 * The resolved request scope for the payment routes (phase 7 §4.3, D11).
 * Exactly one of the two modes is attached by `PaymentsAccessGuard`:
 *
 * - **API-key mode:** the key's (project, environment) scope. The path
 *   `project_id` already equals the key's project (the guard verified it with
 *   404 non-disclosure); no role check applies (phase 6 D6 pattern).
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

export type PaymentsScope = ApiKeyModeScope | SessionModeScope;

/**
 * Returns the scope attached by `PaymentsAccessGuard`. Presence is guaranteed
 * only behind `@UseGuards(PaymentsAccessGuard)`.
 */
export const PaymentsScope = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): PaymentsScope => {
    const request = ctx.switchToHttp().getRequest<AuthenticatedRequest>();
    const apiKey = request.apiKey as ApiKeyContext | undefined;
    const project = request.project as ResolvedProject | undefined;

    if (apiKey && project) {
      throw new Error('PaymentsAccessGuard attached both API-key and session scopes');
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
    // Programming error: must only be used behind PaymentsAccessGuard.
    throw new Error('PaymentsScope used outside the payments access guard');
  },
);