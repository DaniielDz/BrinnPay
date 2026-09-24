import { Transform } from 'class-transformer';
import { IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';

/**
 * `ProjectUpdate` (phase 5 §4.2): partial update semantics — only the provided
 * field changes; `name` is the only mutable attribute in the contract.
 * `organization_id` and `environments` are immutable.
 */
export class ProjectUpdateDto {
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  name?: string;
}