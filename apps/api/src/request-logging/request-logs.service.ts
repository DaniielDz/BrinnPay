import { Injectable } from '@nestjs/common';

import type { RequestLog as RequestLogRow } from '../../generated/prisma/client';
import {
  buildCursorPage,
  cursorToWhere,
  DEFAULT_LIST_LIMIT,
  type CursorPage,
} from '../organizations/cursor';
import { PrismaService } from '../prisma/prisma.service';
import type { Environment } from '../projects/environment';
import { RequestLogListQueryDto } from './dto/request-log-list-query.dto';

/**
 * The contracted `RequestLog` response projection (`docs/openapi.yaml`). Stated
 * field by field rather than derived from the capture type, so the read surface
 * has its own explicit allowlist: a field added to storage cannot appear in a
 * response until it is deliberately named here (§4.2 rule 4, AC6).
 */
export interface RequestLogResponse {
  id: string;
  request_id: string;
  project_id: string | null;
  organization_id: string | null;
  user_id: string | null;
  api_key_id: string | null;
  environment: Environment | null;
  method: string;
  path: string;
  status_code: number;
  /** Absent when the row does not carry a measurement (contract: optional). */
  duration_ms?: number;
  created_at: Date;
}

/** Row → contract projection. The third and final allowlist of the module. */
function toRequestLog(row: RequestLogRow): RequestLogResponse {
  const response: RequestLogResponse = {
    id: row.id,
    request_id: row.requestId,
    project_id: row.projectId,
    organization_id: row.organizationId,
    user_id: row.userId,
    api_key_id: row.apiKeyId,
    environment: row.environment as Environment | null,
    method: row.method,
    path: row.path,
    status_code: row.statusCode,
    created_at: row.createdAt,
  };
  return row.durationMs === null ? response : { ...response, duration_ms: row.durationMs };
}

/**
 * Read surface of the request-logging capability (phase 11 §4.3).
 *
 * Everything the list may return is decided here: rows are selected by the
 * authorized project only, ordered ascending by UUIDv7 (D4, the same order as
 * every other list), and filtered by the two confirmed optional filters. The
 * project scope comes from the guard, never from a client-supplied value the
 * handler could forget to pin, so cross-project rows are unreachable by cursor
 * manipulation (§8 — tenant isolation).
 */
@Injectable()
export class RequestLogsService {
  constructor(private readonly prisma: PrismaService) {}

  async list(
    projectId: string,
    query: RequestLogListQueryDto,
  ): Promise<CursorPage<RequestLogResponse>> {
    const limit = query.limit ?? DEFAULT_LIST_LIMIT;

    const rows = await this.prisma.requestLog.findMany({
      where: {
        projectId,
        // D1: absent environment → all of the project's records, including the
        // environment-less ones. Present → equality, so environment-less rows
        // are excluded by construction.
        ...(query.environment ? { environment: query.environment } : {}),
        // D8: exact match within the addressed project; no match is an empty
        // page, never a 404.
        ...(query.request_id ? { requestId: query.request_id } : {}),
        ...(cursorToWhere(query.cursor) ?? {}),
      },
      orderBy: { id: 'asc' },
      // One row beyond the page so `has_more` needs no second query.
      take: limit + 1,
    });

    return buildCursorPage(rows.map(toRequestLog), limit);
  }
}
