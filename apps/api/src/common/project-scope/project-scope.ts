import { createParamDecorator, ExecutionContext } from '@nestjs/common';

import type { ApiKeyContext } from '../../api-keys/api-key-context';
import type { AuthenticatedRequest } from '../../auth/current-user';
import type { Environment } from '../../projects/environment';
import type { ResolvedProject } from '../../projects/request-project';

/**
 * The resolved request scope of a project-nested route (phase 10 §14 — the
 * shared extraction of the scope decorator phases 6, 7, and 9 each cloned).
 *
 * Exactly one of the two modes is attached by `ProjectAccessGuard`:
 *
 * - **API-key mode:** the key's (project, environment) scope. The path
 *   `project_id` already equals the key's project (the guard verified it with
 *   404 non-disclosure) and the environment comes from the key, so the service
 *   never has to re-derive it. No role exists (D10): a project-scoped key may
 *   perform every operation within its own project and environment.
 * - **Session mode:** the authenticated user's resolved project (membership in
 *   the owning organization + the route's capability were verified by the guard
 *   with the 404/403 semantics of phases 4/5).
 */
export interface ApiKeyProjectScope {
  mode: 'api_key';
  key: ApiKeyContext;
  project_id: string;
  environment: Environment;
}

export interface SessionProjectScope {
  mode: 'session';
  project: ResolvedProject;
  project_id: string;
}

export type ProjectScope = ApiKeyProjectScope | SessionProjectScope;

/** Returns the scope attached by `ProjectAccessGuard`. */
export const ProjectScope = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): ProjectScope => {
    const request = ctx.switchToHttp().getRequest<AuthenticatedRequest>();
    const apiKey = request.apiKey as ApiKeyContext | undefined;
    const project = request.project as ResolvedProject | undefined;

    if (apiKey && project) {
      throw new Error('ProjectAccessGuard attached both API-key and session scopes');
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
    // Programming error: must only be used behind ProjectAccessGuard.
    throw new Error('ProjectScope used outside the project access guard');
  },
);
