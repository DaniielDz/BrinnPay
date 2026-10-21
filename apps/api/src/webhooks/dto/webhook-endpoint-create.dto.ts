import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

import { ENVIRONMENTS, type Environment } from '../../projects/environment';
import { MAX_WEBHOOK_URL_LENGTH, validateWebhookUrl } from '../webhook-url';

/**
 * `WebhookEndpointCreate` (phase 10 §4.6). `environment` is required — an
 * endpoint is registered in exactly one environment and its events are never
 * mixed (D2/F6). `url` and `event_types` carry the boundary rules; the
 * closed-catalog membership check (D1) is enforced by the service, following the
 * existing pattern where the DTO validates shape and the service defends the
 * business invariant.
 */

/** Bound on the subscription size; the closed catalog is far smaller. */
export const MAX_EVENT_TYPES = 32;

export class WebhookEndpointCreateDto {
  @IsIn(ENVIRONMENTS)
  environment!: Environment;

  /**
   * Validated and normalized by {@link validateWebhookUrl} (phase 10 §4.6). A
   * malformed URL is returned unchanged so the shape validators below produce the
   * field error; the service re-runs the full validation and raises the precise
   * `url` field error.
   */
  @Transform(({ value }: { value: unknown }) => normalizeUrlOrPassThrough(value))
  @IsString()
  @MaxLength(MAX_WEBHOOK_URL_LENGTH)
  url!: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_EVENT_TYPES)
  event_types!: unknown[];

  @IsOptional()
  @IsBoolean()
  enabled?: boolean;
}

/**
 * `WebhookEndpointUpdate` (phase 10 §4.4): a partial update of `url`,
 * `event_types`, and/or `enabled`. The signing secret is never rotated by an
 * update (D8: recovery = delete and recreate). An empty body is rejected by the
 * service — a patch with no field is a caller mistake, not a successful no-op.
 */
export class WebhookEndpointUpdateDto {
  @IsOptional()
  @Transform(({ value }: { value: unknown }) => normalizeUrlOrPassThrough(value))
  @IsString()
  @MaxLength(MAX_WEBHOOK_URL_LENGTH)
  url?: string;

  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_EVENT_TYPES)
  event_types?: unknown[];

  @IsOptional()
  @IsBoolean()
  enabled?: boolean;
}

/** Normalizes a valid URL and passes anything else through untouched. */
function normalizeUrlOrPassThrough(value: unknown): unknown {
  if (typeof value !== 'string') {
    return value;
  }
  try {
    return validateWebhookUrl(value);
  } catch {
    return value;
  }
}
