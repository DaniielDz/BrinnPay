import { Injectable } from '@nestjs/common';

import { Prisma } from '../../generated/prisma/client';
import { ApiError } from '../common/errors/api-error';
import { ErrorCode } from '../common/errors/error-code';
import { uuidv7 } from '../common/uuid/uuid';
import {
  buildCursorPage,
  cursorToWhere,
  DEFAULT_LIST_LIMIT,
  type CursorPage,
} from '../organizations/cursor';
import { isUuidLike } from '../projects/projects.service';
import type { Environment } from '../projects/environment';
import { PrismaService } from '../prisma/prisma.service';
import { generateApiKey, hashApiKey } from './api-key-crypto';

/** `ApiKey` as contracted: metadata only — never the credential material. */
export interface ApiKeyResponse {
  id: string;
  project_id: string;
  environment: Environment;
  created_at: Date;
  revoked_at: Date | null;
}

/** `ApiKeyCreated` as contracted: the plaintext `key` appears exactly once. */
export interface ApiKeyCreatedResponse {
  id: string;
  project_id: string;
  environment: Environment;
  key: string;
  created_at: Date;
}

const API_KEY_NOT_FOUND = () => new ApiError(ErrorCode.NOT_FOUND, 'API key not found', 404);

function isPrismaError(error: unknown, code: string): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === code;
}

/**
 * API-key lifecycle service (phase 5 §4.2/§4.5, D5): creation (hash stored,
 * plaintext returned once), project-wide listing (both environments, revoked
 * keys included), and revocation (immediate, idempotent). The project-scoped
 * routes are authorized by `ProjectRbacGuard`; the service enforces that a key
 * belongs to the addressed project (cross-project `api_key_id` → 404, no
 * disclosure).
 */
@Injectable()
export class ApiKeysService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * List (§4.2, D5): project-wide — both environments' keys, because the
   * contract has no environment filter; each key carries its own
   * `environment`. Includes revoked keys (non-null `revoked_at`) so rotation
   * history is visible. Plaintext is never returned.
   */
  async list(
    projectId: string,
    limit: number = DEFAULT_LIST_LIMIT,
    cursor?: string,
  ): Promise<CursorPage<ApiKeyResponse>> {
    const rows = await this.prisma.apiKey.findMany({
      where: {
        projectId,
        ...(cursorToWhere(cursor) ?? {}),
      },
      orderBy: { id: 'asc' },
      take: limit + 1,
    });
    return buildCursorPage(rows.map(toApiKeyResponse), limit);
  }

  /**
   * Create (§4.2, ADR-0006): generates a credential for the requested
   * environment, stores only its hash, and returns the plaintext exactly once
   * in the response (`ApiKeyCreated.key` appears nowhere else). Multiple
   * active keys per project environment are permitted (required for rotation,
   * D1/D5); global hash uniqueness guards against collisions at the DB layer.
   */
  async create(projectId: string, environment: Environment): Promise<ApiKeyCreatedResponse> {
    const key = generateApiKey(environment);
    const keyHash = hashApiKey(key);

    const now = new Date();
    const row = await this.prisma.apiKey.create({
      data: {
        id: uuidv7(),
        projectId,
        environment,
        keyHash,
        createdAt: now,
      },
    });

    return {
      id: row.id,
      project_id: row.projectId,
      environment: row.environment as Environment,
      key,
      created_at: row.createdAt,
    };
  }

  /**
   * Revoke (§4.2): sets `revoked_at`, effective immediately for lookup.
   * Idempotent for already-revoked keys (204 no-op, mirroring the phase 4
   * cancellation pattern); a non-existent, malformed, or cross-project key id
   * → 404 (`NOT_FOUND`, no disclosure).
   */
  async revoke(projectId: string, apiKeyId: string): Promise<void> {
    if (!isUuidLike(apiKeyId)) {
      throw API_KEY_NOT_FOUND();
    }

    const key = await this.prisma.apiKey.findUnique({ where: { id: apiKeyId } });
    if (!key || key.projectId !== projectId) {
      // A key outside the addressed project is indistinguishable from an
      // unknown one (no cross-project disclosure).
      throw API_KEY_NOT_FOUND();
    }

    if (key.revokedAt) {
      return; // idempotent no-op
    }

    try {
      await this.prisma.apiKey.update({
        where: { id: key.id },
        data: { revokedAt: new Date() },
      });
    } catch (error) {
      if (isPrismaError(error, 'P2025')) {
        // Deleted between the read and the update (project cascade); the key
        // no longer exists.
        throw API_KEY_NOT_FOUND();
      }
      throw error;
    }
  }
}

// ---------------------------------------------------------------------------
// Mappers (snake_case contract projection; UTC timestamps pass through as-is)
// ---------------------------------------------------------------------------

function toApiKeyResponse(key: {
  id: string;
  projectId: string;
  environment: string;
  createdAt: Date;
  revokedAt: Date | null;
}): ApiKeyResponse {
  return {
    id: key.id,
    project_id: key.projectId,
    environment: key.environment as Environment,
    created_at: key.createdAt,
    revoked_at: key.revokedAt,
  };
}