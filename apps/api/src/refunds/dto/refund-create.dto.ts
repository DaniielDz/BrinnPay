import { Transform } from 'class-transformer';
import { IsIn, IsString, Matches, MaxLength, ValidateIf } from 'class-validator';

import { MONEY_AMOUNT_REGEX } from '../../common/money/money';

export class RefundCreateDto {
  @ValidateIf((_object: object, value: unknown) => value !== undefined)
  @IsString()
  @Matches(MONEY_AMOUNT_REGEX)
  amount?: string;

  @ValidateIf((_object: object, value: unknown) => value !== undefined)
  @IsIn(['usd'])
  currency?: 'usd';

  @ValidateIf((_object: object, value: unknown) => value !== undefined)
  @Transform(({ value }: { value: unknown }) => typeof value === 'string' ? value.trim() : value)
  @IsString()
  @MaxLength(255)
  reason?: string;
}
