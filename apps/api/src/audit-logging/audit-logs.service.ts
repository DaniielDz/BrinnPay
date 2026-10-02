import { Injectable } from '@nestjs/common';

import type { AuditLogEntry as AuditLogEntryRow } from '../../generated/prisma/client';
import {
  buildCursorPage,
  cursorToWhere,
  DEFAULT_LIST_LIMIT,
  type CursorPage,
  type ListQueryDto,
} from '../organizations/cursor';
import { PrismaService } from '../prisma/prisma.service';
import type { AuditData } from './audit-actions';

/**
 * The contracted `AuditLogEntry` response projection (`docs/openapi.yaml`).
 * Stated field by field rather than derived from the row type, so the read
 * surface has its own explicit allowlist: a column added to storage cannot
 * appear in a response until it is deliberately named here (§4.2 rule 7).
 */
export interface AuditLogEntryResponse {
  id: string;
  organization_id: string;
  actor_type: string;
  actor_id: string | null;
  action: string;
  resource_type: string;
  resource_id: string | null;
  /** D6: present for project-scoped actions; `null` otherwise. */
  project_id: string | null;
  /** D6: `test`/`live` for project-scoped actions; `null` otherwise. */
  environment: string | null;
  /** Omitted when the entry carries no allowlisted context (contract: optional). */
  data?: AuditData;
  created_at: Date;
}

/** Row → contract projection. The second and final allowlist of the module. */
function toAuditLogEntry(row: AuditLogEntryRow): AuditLogEntryResponse {
  const response: AuditLogEntryResponse = {
    id: row.id,
    organization_id: row.organizationId,
    actor_type: row.actorType,
    actor_id: row.actorId,
    action: row.action,
    resource_type: row.resourceType,
    resource_id: row.resourceId,
    project_id: row.projectId,
    environment: row.environment,
    created_at: row.createdAt,
  };
  // `data` is written only through the per-action builders (§4.2 rule 7) and
  // omitted entirely when empty; the projection mirrors that, and a non-object
  // value (impossible through the write path) is dropped rather than echoed.
  const data = row.data;
  if (data !== null && typeof data === 'object' && !Array.isArray(data)) {
    response.data = data as AuditData;
  }
  return response;
}

/**
 * Read surface of the audit-logging capability (phase 12 §4.3).
 *
 * The list is organization-wide — every project and both environments of the
 * addressed tenant (D12) — and returns nothing else: rows are selected by the
 * organization the org-scoped RBAC guard resolved, ordered ascending by
 * UUIDv7 (D10, the same order as every other list), so a cursor can never
 * escape the authorized tenant (§9 tenant isolation). No filter exists beyond
 * pagination (D11).
 */
@Injectable()
export class AuditLogsService {
  constructor(private readonly prisma: PrismaService) {}

  async list(
    organizationId: string,
    query: ListQueryDto,
  ): Promise<CursorPage<AuditLogEntryResponse>> {
    const limit = query.limit ?? DEFAULT_LIST_LIMIT;

    const rows = await this.prisma.auditLogEntry.findMany({
      where: {
        organizationId,
        ...(cursorToWhere(query.cursor) ?? {}),
      },
      orderBy: { id: 'asc' },
      // One row beyond the page so `has_more` needs no second query.
      take: limit + 1,
    });

    return buildCursorPage(rows.map(toAuditLogEntry), limit);
  }
}
