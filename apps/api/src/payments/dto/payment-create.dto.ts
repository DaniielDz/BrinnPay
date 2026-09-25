import { Transform } from 'class-transformer';
import { IsIn, IsString, IsUUID, Matches, MaxLength, ValidateIf } from 'class-validator';

import { MONEY_AMOUNT_REGEX } from '../../common/money/money';
import { ENVIRONMENTS, type Environment } from '../../projects/environment';

/**
 * `PaymentCreate` (phase 7 §4.2): the target environment, the customer of the
 * same (project, environment), the strictly-positive decimal-string `amount`
 * (format enforced here at the boundary; positivity by the money helper in the
 * service — D7), `currency` limited to `usd` (ADR-0003), and an optional
 * trimmed `description` (≤ 500 chars, D9; whitespace-only rejected by the
 * service; absent → `null`).
 *
 * `customer_id`/`description` are non-nullable in the contract, so an explicit
 * `null` is rejected (400) by the boundary validators (`@ValidateIf` runs them
 * for every defined value). A malformed `customer_id` UUID is a 400 field
 * error at the boundary (D3/§7.7); an unknown or cross-scope customer is a 404
 * resolved by the service (non-disclosure).
 */
export class PaymentCreateDto {
  @IsIn(ENVIRONMENTS)
  environment!: Environment;

  @IsUUID()
  customer_id!: string;

  @IsString()
  @Matches(MONEY_AMOUNT_REGEX)
  amount!: string;

  @IsIn(['usd'])
  currency!: 'usd';

  @ValidateIf((_o: object, value: unknown) => value !== undefined)
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @MaxLength(500)
  description?: string;
}