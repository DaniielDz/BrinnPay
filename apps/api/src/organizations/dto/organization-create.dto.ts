import { Transform } from 'class-transformer';
import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

/**
 * `OrganizationCreate` (phase 4 §4.2 create): the trimmed name is non-empty
 * and ≤ 200 chars (D7); names are display values, never globally unique.
 */
export class OrganizationCreateDto {
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  name!: string;
}