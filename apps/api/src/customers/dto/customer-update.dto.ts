import { Transform } from 'class-transformer';
import {
  IsEmail,
  IsNotEmpty,
  IsString,
  MaxLength,
  ValidateIf,
} from 'class-validator';

import { IsFlatStringMap } from './metadata';

/**
 * `CustomerUpdate` (phase 6 §4.2): partial update of `email` / `name` /
 * `metadata` — only provided fields change. `environment` and `project_id`
 * are immutable and are not part of the schema (the contract omits them).
 *
 * Clearing `name` to `null` is not supported in the MVP (D7): `name` is a
 * non-nullable string in the contract, so a PATCH omitting it leaves it
 * unchanged and a PATCH providing no fields is a no-op returning the current
 * state. An explicit `null` (or any non-string value) is rejected (400) by
 * the boundary validators (`@ValidateIf` runs them for every defined value).
 */
export class CustomerUpdateDto {
  @ValidateIf((_o: object, value: unknown) => value !== undefined)
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsEmail()
  @MaxLength(320)
  email?: string;

  @ValidateIf((_o: object, value: unknown) => value !== undefined)
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  name?: string;

  @ValidateIf((_o: object, value: unknown) => value !== undefined)
  @IsFlatStringMap()
  metadata?: Record<string, string>;
}