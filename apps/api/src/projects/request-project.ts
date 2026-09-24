import { createParamDecorator, ExecutionContext } from '@nestjs/common';

import type { Project as PrismaProject } from '../../generated/prisma/client';
import type { AuthenticatedRequest } from '../auth/current-user';

/**
 * The project context attached to a request by `ProjectRbacGuard` (phase 5
 * §4.1/D2). Route handlers consume it via `@CurrentProject()` instead of
 * re-deriving the project, keeping the guard the single authorization boundary
 * for project-scoped routes.
 */
export interface ResolvedProject {
  project_id: string;
  organization_id: string;
}

export function toResolvedProject(project: Pick<PrismaProject, 'id' | 'organizationId'>): ResolvedProject {
  return {
    project_id: project.id,
    organization_id: project.organizationId,
  };
}

/**
 * Returns the project context attached by `ProjectRbacGuard`. Presence is
 * guaranteed only behind `@UseGuards(SessionAuthGuard, ProjectRbacGuard)`.
 */
export const CurrentProject = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): ResolvedProject => {
    const request = ctx.switchToHttp().getRequest<AuthenticatedRequest>();
    const project = request.project as ResolvedProject | undefined;
    if (!project) {
      // Programming error: must only be used behind the project-scoped guard.
      throw new Error('CurrentProject used outside a project-scoped guard');
    }
    return project;
  },
);