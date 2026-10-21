import { IsIn } from 'class-validator';

import { ROLES, type Role } from '../roles';

/**
 * `OrganizationMemberUpdate` body: the target role (phase 4 §4.2 updateMember).
 * The role enum is app-validated at the boundary (D10).
 */
export class MemberRoleDto {
  @IsIn(ROLES)
  role!: Role;
}