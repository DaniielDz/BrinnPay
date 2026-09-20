import { IsEmail, IsIn, MaxLength } from 'class-validator';

import { ROLES, type Role } from '../roles';

/**
 * `InvitationCreate` body (phase 4 §4.2 createInvitation): normalized email
 * (Phase 3 D8 convention) and the invited role (D10). Whether `role` may be
 * `owner` is decided by the actor's own role in the service (D5).
 */
export class InvitationCreateDto {
  @IsEmail()
  @MaxLength(320)
  email!: string;

  @IsIn(ROLES)
  role!: Role;
}