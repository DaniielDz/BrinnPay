/**
 * Phase 4 role and permission model (§4.3, D2/D3).
 *
 * Single source of truth for role constants, capabilities, and the
 * role → capability matrix inside `apps/api`. The RBAC guard, the
 * organization service, and the DTOs all derive from here; later phases
 * (5–13) extend the capability registry without duplicating the matrix.
 */

export const ROLES = ['owner', 'admin', 'member', 'viewer'] as const;
export type Role = (typeof ROLES)[number];

export const CAPABILITIES = {
  ORGANIZATIONS_READ: 'organizations.read',
  ORGANIZATIONS_UPDATE: 'organizations.update',
  ORGANIZATIONS_DELETE: 'organizations.delete',
  MEMBERS_READ: 'members.read',
  MEMBERS_UPDATE: 'members.update',
  MEMBERS_REMOVE: 'members.remove',
  INVITATIONS_READ: 'invitations.read',
  INVITATIONS_CREATE: 'invitations.create',
  INVITATIONS_CANCEL: 'invitations.cancel',
  PROJECTS_READ: 'projects.read',
  PROJECTS_CREATE: 'projects.create',
  PROJECTS_UPDATE: 'projects.update',
  PROJECTS_DELETE: 'projects.delete',
  API_KEYS_READ: 'apiKeys.read',
  API_KEYS_CREATE: 'apiKeys.create',
  API_KEYS_REVOKE: 'apiKeys.revoke',
} as const;

export type Capability = (typeof CAPABILITIES)[keyof typeof CAPABILITIES];

/**
 * The Phase 4 matrix (§4.3). Rows list the roles granted each capability.
 * Target-level restrictions (non-`owner` targets for admins, `owner`-granting
 * by owners only) and self-service exceptions (`members.remove` self-removal,
 * `members.update` self-demotion) are enforced by the service layer on top of
 * this matrix.
 */
const MATRIX: Record<Capability, readonly Role[]> = {
  [CAPABILITIES.ORGANIZATIONS_READ]: ['owner', 'admin', 'member', 'viewer'],
  [CAPABILITIES.ORGANIZATIONS_UPDATE]: ['owner', 'admin'],
  [CAPABILITIES.ORGANIZATIONS_DELETE]: ['owner'],
  [CAPABILITIES.MEMBERS_READ]: ['owner', 'admin', 'member', 'viewer'],
  [CAPABILITIES.MEMBERS_UPDATE]: ['owner', 'admin'],
  [CAPABILITIES.MEMBERS_REMOVE]: ['owner', 'admin'],
  [CAPABILITIES.INVITATIONS_READ]: ['owner', 'admin'],
  [CAPABILITIES.INVITATIONS_CREATE]: ['owner', 'admin'],
  [CAPABILITIES.INVITATIONS_CANCEL]: ['owner', 'admin'],
  // Phase 5 matrix (§4.3, D3): read/project and read/api-keys for every
  // member role; create/update/delete/revoke are administrative (owner+admin).
  [CAPABILITIES.PROJECTS_READ]: ['owner', 'admin', 'member', 'viewer'],
  [CAPABILITIES.PROJECTS_CREATE]: ['owner', 'admin'],
  [CAPABILITIES.PROJECTS_UPDATE]: ['owner', 'admin'],
  [CAPABILITIES.PROJECTS_DELETE]: ['owner', 'admin'],
  [CAPABILITIES.API_KEYS_READ]: ['owner', 'admin', 'member', 'viewer'],
  [CAPABILITIES.API_KEYS_CREATE]: ['owner', 'admin'],
  [CAPABILITIES.API_KEYS_REVOKE]: ['owner', 'admin'],
};

export function isRole(value: string): value is Role {
  return (ROLES as readonly string[]).includes(value);
}

export function can(role: Role, capability: Capability): boolean {
  return MATRIX[capability].includes(role);
}

/** Owner > admin > member > viewer; used for the self-demotion rule. */
const ROLE_RANK: Record<Role, number> = {
  owner: 4,
  admin: 3,
  member: 2,
  viewer: 1,
};

/** Whether `to` is strictly lower-ranked than `from`. */
export function isDownward(from: Role, to: Role): boolean {
  return ROLE_RANK[to] < ROLE_RANK[from];
}