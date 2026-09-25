import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

import { MAX_LIST_LIMIT } from '../../organizations/cursor';
import { ENVIRONMENTS, type Environment } from '../../projects/environment';

/**
 * `payments.list` query (phase 7 §4.2/§4.5): the shared `limit`/`cursor`
 * pagination parameters plus the environment filter. The contract defines no
 * search, customer, or status filter — none are invented.
 *
 * `environment` is optional in the DTO because the contract declares
 * `required: false` — but that only covers the API-key path where the
 * environment is derived from the key. A session-authenticated request
 * without an explicit environment cannot be served (TEST/LIVE data is never
 * mixed, D1) and is rejected as 400 `VALIDATION_ERROR` by the service.
 */
export class PaymentListQueryDto {
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

  @IsOptional()
  @IsIn(ENVIRONMENTS)
  environment?: Environment;
}