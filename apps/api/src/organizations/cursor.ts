import { IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { Type } from 'class-transformer';

export const DEFAULT_LIST_LIMIT = 20;
export const MAX_LIST_LIMIT = 100;

/**
 * Cursor pagination (phase 1 §7.5, phase 4 §4.5). The cursor is the last
 * entity ID of the previous page; UUIDv7 IDs are time-ordered (ADR-0001), so
 * `id > cursor` reproduces the ordering. Cursors are opaque to clients.
 *
 * The shared pattern Phase 6 generalizes to customers.
 */
export interface CursorPage<T> {
  data: T[];
  next_cursor: string | null;
  has_more: boolean;
}

export function buildCursorPage<T extends { id: string }>(rows: T[], limit: number): CursorPage<T> {
  const hasMore = rows.length > limit;
  const data = hasMore ? rows.slice(0, limit) : rows;
  return {
    data,
    next_cursor: hasMore && data.length > 0 ? data[data.length - 1].id : null,
    has_more: hasMore,
  };
}

export interface CursorWhere {
  id: { gt: string };
}

export function cursorToWhere(cursor: string | undefined): CursorWhere | undefined {
  return cursor ? { id: { gt: cursor } } : undefined;
}

/**
 * Shared query DTO for the paginated list endpoints (`limit`, `cursor` per the
 * contract's `Limit`/`Cursor` parameters).
 */
export class ListQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_LIST_LIMIT)
  limit?: number;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  cursor?: string;
}