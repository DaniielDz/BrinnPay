import { Transform } from 'class-transformer';
import {
  IsEmail,
  IsIn,
  IsNotEmpty,
  IsString,
  MaxLength,
  ValidateIf,
} from 'class-validator';

import { ENVIRONMENTS, type Environment } from '../../projects/environment';
import { IsFlatStringMap } from './metadata';

/**
 * `CustomerCreate` (phase 6 §4.2): the target environment, the required email
 * (validated format, ≤ 320 chars; trimmed + lowercased by the service before
 * persistence), an optional non-empty name (≤ 200 chars, trimmed), and
 * optional flat string-map metadata (D6; absent → `{}`). `name`/`metadata`
 * are non-nullable in the contract, so an explicit `null` is rejected (400)
 * by the boundary validators (`@ValidateIf` runs them for every defined
 * value).
 *
 * The email is deliberately **not unique** (D1): customer identity is the
 * UUIDv7 id and multiple customers may share an email within a
 * project/environment.
 */
export class CustomerCreateDto {
  @IsIn(ENVIRONMENTS)
  environment!: Environment;

  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsEmail()
  @MaxLength(320)
  email!: string;

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