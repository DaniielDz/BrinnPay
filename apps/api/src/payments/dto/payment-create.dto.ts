import { Transform } from 'class-transformer';
import {
  IsIn,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  registerDecorator,
  ValidateIf,
  type ValidationArguments,
  type ValidationOptions,
} from 'class-validator';

import { MONEY_AMOUNT_REGEX } from '../../common/money/money';
import { ENVIRONMENTS, type Environment } from '../../projects/environment';
import {
  FAILURE_CODES,
  PAYMENT_SCENARIOS,
  type FailureCode,
  type PaymentScenario,
} from '../payment-scenario';

/**
 * Cross-field rule of phase 16 §4.2 (D1 (a)): `failure_code` is only valid
 * together with `scenario: "decline"`, because nowhere else does the settlement
 * edge write a code.
 *
 * It is expressed as a property constraint so a violation reports on
 * `failure_code` itself (the house envelope's `details.fields[].field`), rather
 * than on the DTO class. An `undefined` or `null` value is left to `@IsIn`,
 * which already rejects `null` — this validator only ever owns the
 * "present but the scenario is wrong" case, so a message is never duplicated.
 */
function IsDeclineScenarioFailureCode(options?: ValidationOptions) {
  return function (object: object, propertyName: string): void {
    registerDecorator({
      target: object.constructor,
      propertyName,
      options,
      constraints: [],
      validator: {
        validate(value: unknown, args: ValidationArguments): boolean {
          if (value === undefined || value === null) {
            return true;
          }
          return (args.object as PaymentCreateDto).scenario === 'decline';
        },
        defaultMessage(): string {
          return 'failure_code requires scenario "decline"';
        },
      },
    });
  };
}

/**
 * `PaymentCreate` (phase 7 §4.2, extended by phase 16 §4.2): the target
 * environment, the customer of the same (project, environment), the
 * strictly-positive decimal-string `amount` (format enforced here at the
 * boundary; positivity by the money helper in the service — D7), `currency`
 * limited to `usd` (ADR-0003), an optional trimmed `description` (≤ 500 chars,
 * D9; whitespace-only rejected by the service; absent → `null`), plus the two
 * optional scenario fields of phase 16:
 *
 * - `scenario` — closed enum `succeed` (default) | `decline` | `timeout`;
 *   absent behaves exactly like `succeed` (backwards compatibility is absolute,
 *   §4.3 rule 3);
 * - `failure_code` — a value from the §4.5 catalog, valid only with
 *   `scenario: "decline"`, absent ⇒ the catalog default `card_declined`.
 *
 * `customer_id`, `description`, `scenario` and `failure_code` are non-nullable
 * when present, so an explicit `null` is rejected (400) by the boundary
 * validators (`@ValidateIf` runs them for every defined value — it skips
 * `undefined` only, which is what makes the fields optional). A malformed
 * `customer_id` UUID is a 400 field error at the boundary (D3/§7.7); an unknown
 * or cross-scope customer is a 404 resolved by the service (non-disclosure).
 *
 * Every scenario rule is resolved here, **before** the idempotency claim, so an
 * invalid request creates no payment, no event and no audit entry and leaves the
 * `Idempotency-Key` reusable (§4.2, AC4).
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

  @ValidateIf((_o: object, value: unknown) => value !== undefined)
  @IsIn(PAYMENT_SCENARIOS)
  scenario?: PaymentScenario;

  @ValidateIf((_o: object, value: unknown) => value !== undefined)
  @IsIn(FAILURE_CODES)
  @IsDeclineScenarioFailureCode()
  failure_code?: FailureCode;
}
