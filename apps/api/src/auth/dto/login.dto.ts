import { IsEmail, IsString, MaxLength } from 'class-validator';

/**
 * Login keeps password bounds unstated so a wrong-format password cannot
 * enumerate policy details (it becomes a generic 401 instead of a 400).
 */
export class LoginDto {
  @IsString()
  @IsEmail()
  @MaxLength(320)
  email!: string;

  @IsString()
  @MaxLength(1024)
  password!: string;
}