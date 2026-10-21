import { Transform } from 'class-transformer';
import { IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';

/**
 * `OrganizationUpdate` (phase 4 §4.2 update): partial update semantics; `name`
 * is the only mutable attribute, with the same bounds as create (D7).
 */
export class OrganizationUpdateDto {
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  name?: string;
}