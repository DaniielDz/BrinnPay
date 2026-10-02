import { Transform } from 'class-transformer';
import { IsIn, IsOptional, IsString, Matches } from 'class-validator';

import { ListQueryDto } from '../../organizations/cursor';
import { ENVIRONMENTS, type Environment } from '../../projects/environment';

/**
 * The request-id scheme this server generates at ingress (phase 1 §7.8):
 * `req_` followed by the 32 hex characters of a UUID without separators. The
 * D8 filter is an *exact* match against that scheme, so a malformed value is a
 * 400 field error rather than a query that can never return a row — and a
 * value from another system's id namespace can never be smuggled into the
 * WHERE clause (Prisma parameterizes it anyway; this is the input boundary).
 */
export const REQUEST_ID_PATTERN = /^req_[0-9a-f]{32}$/;

const REQUEST_ID_ERROR =
  'request_id must be a server-assigned request id of the form req_<32 hex characters>';

/**
 * List query for `logs.listRequestLogs` (phase 11 §4.3, D1/D8).
 *
 * Both filters are optional by decision: the contract states no requiredness
 * for `environment` on this operation (F1), so there is deliberately **no**
 * "environment is required under session auth" 400-rule here — a missing
 * environment returns records of both environments plus the environment-less
 * ones. An invalid value is still a 400 field error.
 */
export class RequestLogListQueryDto extends ListQueryDto {
  @IsOptional()
  @IsIn(ENVIRONMENTS)
  environment?: Environment;

  /** D8: exact lookup of one request within the addressed project. */
  @IsOptional()
  @Transform(({ value }: { value: unknown }) => {
    if (typeof value !== 'string') return value;
    const trimmed = value.trim();
    // An empty term is treated as absent (Phase 6 D3 precedent): the filter
    // simply does not apply, rather than erroring on a cleared input box.
    return trimmed.length === 0 ? undefined : trimmed;
  })
  @IsString()
  @Matches(REQUEST_ID_PATTERN, { message: REQUEST_ID_ERROR })
  request_id?: string;
}
