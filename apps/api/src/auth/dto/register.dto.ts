import { IsEmail, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

/**
 * D6 bounds: `minLength 8` (contracted), `maxLength 128` (DoS bound), no
 * composition rules (NIST-style).
 */
export class RegisterDto {
  @IsString()
  @IsEmail()
  @MaxLength(320)
  email!: string;

  @IsString()
  @MinLength(8)
  @MaxLength(128)
  password!: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  name?: string;
}