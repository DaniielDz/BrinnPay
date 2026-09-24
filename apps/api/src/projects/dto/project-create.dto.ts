import { Transform } from 'class-transformer';
import { IsNotEmpty, IsString, IsUUID, MaxLength } from 'class-validator';

/**
 * `ProjectCreate` (phase 5 §4.2): the target organization plus the trimmed
 * project name (non-empty, ≤ 200 chars — mirroring organization names, D7).
 * Names are display values and are deliberately not unique; project identity
 * is the UUIDv7 ID.
 */
export class ProjectCreateDto {
  @IsUUID()
  organization_id!: string;

  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  name!: string;
}