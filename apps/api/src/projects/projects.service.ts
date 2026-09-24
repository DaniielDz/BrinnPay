import { Injectable } from '@nestjs/common';

import { Prisma } from '../../generated/prisma/client';
import { type AuthUser } from '../auth/current-user';
import { ApiError } from '../common/errors/api-error';
import { ErrorCode } from '../common/errors/error-code';
import { uuidv7 } from '../common/uuid/uuid';
import {
  buildCursorPage,
  cursorToWhere,
  DEFAULT_LIST_LIMIT,
  type CursorPage,
} from '../organizations/cursor';
import { can, isRole } from '../organizations/roles';
import { PrismaService } from '../prisma/prisma.service';
import { ENVIRONMENTS, type Environment } from './environment';
import { type ResolvedProject } from './request-project';

/** `Project` as contracted (phase 5 §4.2): the `environments` array is always a
 *  projection of the two available simulated environments (D6). */
export interface ProjectResponse {
  id: string;
  organization_id: string;
  name: string;
  created_at: Date;
  updated_at: Date;
  environments: Environment[];
}

const PROJECT_NOT_FOUND = () => new ApiError(ErrorCode.NOT_FOUND, 'Project not found', 404);

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isPrismaError(error: unknown, code: string): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === code;
}

/**
 * Projects domain service (phase 5 §4.2). Owns project persistence and rules.
 * Project-scoped routes are already authorized by `ProjectRbacGuard`; the two
 * exceptions resolved here (mirroring the guard's 404/403 semantics) are
 * `create` — whose target organization arrives in the body, not the path — and
 * the not-found races that can occur after authorization succeeded.
 */
@Injectable()
export class ProjectsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * List (§4.2): projects of every organization the caller belongs to. No
   * capability check applies — the list is inherently scoped to the caller's
   * memberships, mirroring `organizations.list`.
   */
  async listForUser(
    userId: string,
    limit: number = DEFAULT_LIST_LIMIT,
    cursor?: string,
  ): Promise<CursorPage<ProjectResponse>> {
    const rows = await this.prisma.project.findMany({
      where: {
        organization: { members: { some: { userId } } },
        ...(cursorToWhere(cursor) ?? {}),
      },
      orderBy: { id: 'asc' },
      take: limit + 1,
    });
    return buildCursorPage(rows.map(toProjectResponse), limit);
  }

  /**
   * Create (§4.2): the caller must be a member of the target organization and
   * hold `projects.create` (D3). The target org id arrives in the body, so the
   * membership/capability resolution happens here with the same 404/403
   * semantics as the project-scoped guard: a non-member receives 404 (`NOT_FOUND`,
   * the organization is not visible to the caller), a member without the
   * capability receives 403.
   */
  async create(user: AuthUser, organizationId: string, name: string): Promise<ProjectResponse> {
    const validatedName = this.validateName(name);

    const membership = await this.prisma.organizationMember.findUnique({
      where: { organizationId_userId: { organizationId, userId: user.id } },
    });

    if (!membership) {
      throw new ApiError(ErrorCode.NOT_FOUND, 'Organization not found', 404);
    }
    if (!isRole(membership.role) || !can(membership.role, 'projects.create')) {
      throw new ApiError(ErrorCode.FORBIDDEN, 'Insufficient permissions', 403);
    }

    const now = new Date();
    const project = await this.prisma.project.create({
      data: {
        id: uuidv7(),
        organizationId,
        name: validatedName,
        createdAt: now,
        updatedAt: now,
      },
    });
    return toProjectResponse(project);
  }

  /**
   * Retrieve (§4.2): membership and capability were verified by the
   * project-scoped guard; this covers the delete/access race with 404.
   */
  async retrieve(projectId: string): Promise<ProjectResponse> {
    const project = await this.prisma.project.findUnique({ where: { id: projectId } });
    if (!project) {
      throw PROJECT_NOT_FOUND();
    }
    return toProjectResponse(project);
  }

  /** Update (§4.2): name-only partial update; `updated_at` advances. */
  async update(projectId: string, name?: string): Promise<ProjectResponse> {
    if (name === undefined) {
      // Partial update: no field provided → no-op returning the current state.
      const project = await this.prisma.project.findUnique({ where: { id: projectId } });
      if (!project) {
        throw PROJECT_NOT_FOUND();
      }
      return toProjectResponse(project);
    }

    const validatedName = this.validateName(name);
    try {
      const project = await this.prisma.project.update({
        where: { id: projectId },
        data: { name: validatedName, updatedAt: new Date() },
      });
      return toProjectResponse(project);
    } catch (error) {
      if (isPrismaError(error, 'P2025')) {
        throw PROJECT_NOT_FOUND();
      }
      throw error;
    }
  }

  /**
   * Delete (§4.2): the DB cascades the project's tenant-scoped rows — `api_keys`
   * today — via FK `ON DELETE CASCADE` (D7). All of the project's API keys are
   * implicitly revoked: their rows are removed, so lookup finds no row.
   */
  async delete(projectId: string): Promise<void> {
    try {
      await this.prisma.project.delete({ where: { id: projectId } });
    } catch (error) {
      if (isPrismaError(error, 'P2025')) {
        throw PROJECT_NOT_FOUND();
      }
      throw error;
    }
  }

  /** Convenience for guards/services that need the project's owning org. */
  async resolve(projectId: string): Promise<ResolvedProject> {
    const project = await this.prisma.project.findUnique({ where: { id: projectId } });
    if (!project) {
      throw PROJECT_NOT_FOUND();
    }
    return { project_id: project.id, organization_id: project.organizationId };
  }

  private validateName(name: string): string {
    const trimmed = name.trim();
    if (trimmed.length === 0) {
      throw ApiError.validation({
        fields: [{ field: 'name', errors: ['Project name must not be empty'] }],
      });
    }
    if (trimmed.length > 200) {
      throw ApiError.validation({
        fields: [{ field: 'name', errors: ['Project name must be at most 200 characters'] }],
      });
    }
    return trimmed;
  }
}

/** Malformed `api_key_id`/`project_id` values are treated as non-existent for
 *  the handful of routes that receive secondary IDs (404 non-disclosure). */
export function isUuidLike(value: string): boolean {
  return UUID_PATTERN.test(value);
}

// ---------------------------------------------------------------------------
// Mappers (snake_case contract projection; UTC timestamps pass through as-is)
// ---------------------------------------------------------------------------

function toProjectResponse(project: {
  id: string;
  organizationId: string;
  name: string;
  createdAt: Date;
  updatedAt: Date;
}): ProjectResponse {
  return {
    id: project.id,
    organization_id: project.organizationId,
    name: project.name,
    created_at: project.createdAt,
    updated_at: project.updatedAt,
    // D6: both environments are always available in the MVP; derived, not stored.
    environments: [...ENVIRONMENTS],
  };
}