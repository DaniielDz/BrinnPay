import { Transform } from 'class-transformer';
import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';

import { ApiError } from '../../common/errors/api-error';
import { ENVIRONMENTS, type Environment } from '../../projects/environment';
import { ListQueryDto } from '../../organizations/cursor';
import { isWebhookEventType, WEBHOOK_EVENT_TYPES } from '../webhook-events';
import { DELIVERY_STATUSES, type DeliveryStatus } from '../webhook-retry';

/**
 * List query DTOs for the webhook surface (phase 10 §4.4, D15).
 *
 * The optional `type` filter on `webhook-events` and `status` filter on
 * `.../deliveries` are additive and backward compatible: an absent filter
 * returns everything, a filter never changes cursor semantics, and pagination
 * stays stable under filtering. An unknown filter value is a 400 field error.
 */

export class WebhookEndpointListQueryDto extends ListQueryDto {
  @IsOptional()
  @IsIn(ENVIRONMENTS)
  environment?: Environment;
}

export class WebhookEventListQueryDto extends ListQueryDto {
  @IsOptional()
  @IsIn(ENVIRONMENTS)
  environment?: Environment;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  type?: string;
}

export class WebhookDeliveryListQueryDto extends ListQueryDto {
  @IsOptional()
  @IsString()
  @MaxLength(20)
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  status?: string;
}

/**
 * Validates the optional `type` filter (D15). The DTO can only bound the shape;
 * the closed-catalog check lives here so an unknown value is a 400 field error
 * that names the accepted types instead of silently matching nothing.
 */
export function resolveEventTypeFilter(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isWebhookEventType(value)) {
    throw ApiError.validation({
      fields: [
        {
          field: 'type',
          errors: [`type must be one of: ${WEBHOOK_EVENT_TYPES.join(', ')}`],
        },
      ],
    });
  }
  return value;
}

/** Validates the optional `status` filter (D15) against the contract enum. */
export function resolveDeliveryStatusFilter(value: string | undefined): DeliveryStatus | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!(DELIVERY_STATUSES as readonly string[]).includes(value)) {
    throw ApiError.validation({
      fields: [
        {
          field: 'status',
          errors: [`status must be one of: ${DELIVERY_STATUSES.join(', ')}`],
        },
      ],
    });
  }
  return value as DeliveryStatus;
}
