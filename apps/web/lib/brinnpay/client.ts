/**
 * Minimal BrinnPay API client for the browser (phases 3–4: session auth and
 * the organizations/RBAC surface).
 *
 * The refresh cookie is `HttpOnly` and scoped to `/api/v1/auth`, so it travels
 * automatically with these requests; the access token is kept in memory by the
 * caller on `AuthProvider`. Org-scoped requests pass the token explicitly via
 * `Authorization` (phase 4 §4.3; API keys arrive in Phase 5).
 *
 * `NEXT_PUBLIC_API_BASE_URL` allows pointing at the API (e.g.
 * `http://localhost:3000/api/v1` during local development). Defaults to the
 * local development API (phase 3 §5.2.6).
 */
export interface PublicUser {
  id: string;
  email: string;
  name: string | null;
  created_at: string;
  updated_at: string;
}

export interface AuthSession {
  access_token: string;
  token_type: 'Bearer';
  expires_in: number;
  user: PublicUser;
}

export interface AccessTokenPayload {
  access_token: string;
  token_type: 'Bearer';
  expires_in: number;
}

export interface ApiErrorEnvelope {
  error: {
    code: string;
    message: string;
    request_id?: string;
    details?: unknown;
  };
}

export interface RegisterInput {
  email: string;
  password: string;
  name?: string;
}

// ---------------------------------------------------------------------------
// Organizations / members / invitations (phase 4; D8 representation)
// ---------------------------------------------------------------------------

export type Role = 'owner' | 'admin' | 'member' | 'viewer';

export interface Organization {
  id: string;
  name: string;
  created_at: string;
  updated_at: string;
}

export interface MemberIdentity {
  id: string;
  email: string;
  name: string | null;
}

export interface OrganizationMember {
  id: string;
  organization_id: string;
  user_id: string;
  role: Role;
  created_at: string;
  updated_at: string;
  user: MemberIdentity;
}

export type InvitationStatus = 'pending' | 'accepted' | 'canceled';

export interface Invitation {
  id: string;
  organization_id: string;
  email: string;
  role: Role;
  status: InvitationStatus;
  created_at: string;
  updated_at: string;
  accepted_at: string | null;
  canceled_at: string | null;
}

export interface CursorPage<T> {
  data: T[];
  next_cursor: string | null;
  has_more: boolean;
}

export interface CreateOrganizationInput {
  name: string;
}

export interface CreateInvitationInput {
  email: string;
  role: Role;
}

export interface UpdateMemberInput {
  role: Role;
}

const API_BASE_URL = process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://localhost:3000/api/v1';

export class ApiClientError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly requestId?: string,
  ) {
    super(message);
    this.name = 'ApiClientError';
  }
}

async function apiFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${API_BASE_URL}${path}`, {
    ...init,
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      ...init.headers,
    },
  });

  if (response.status === 204) {
    return undefined as T;
  }

  const body = (await response.json().catch(() => null)) as ApiErrorEnvelope | T | null;

  if (!response.ok) {
    const envelope = body as ApiErrorEnvelope | null;
    throw new ApiClientError(
      response.status,
      envelope?.error?.code ?? 'UNKNOWN_ERROR',
      envelope?.error?.message ?? `Request failed with status ${response.status}`,
      envelope?.error?.request_id,
    );
  }

  return body as T;
}

export function register(input: RegisterInput): Promise<AuthSession> {
  return apiFetch<AuthSession>('/auth/register', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function login(email: string, password: string): Promise<AuthSession> {
  return apiFetch<AuthSession>('/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email, password }),
  });
}

export async function refresh(): Promise<AuthSession> {
  return apiFetch<AuthSession>('/auth/refresh', { method: 'POST' });
}

export async function logout(): Promise<void> {
  return apiFetch<void>('/auth/logout', { method: 'POST' });
}

export function me(accessToken: string): Promise<PublicUser> {
  return apiFetch<PublicUser>('/auth/me', {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
}

// ---------------------------------------------------------------------------
// Organizations (phase 4 §4.2)
// ---------------------------------------------------------------------------

export function listOrganizations(
  accessToken: string,
  query: { limit?: number; cursor?: string } = {},
): Promise<CursorPage<Organization>> {
  const params = new URLSearchParams();
  if (query.limit !== undefined) params.set('limit', String(query.limit));
  if (query.cursor) params.set('cursor', query.cursor);
  const suffix = params.size > 0 ? `?${params}` : '';
  return apiFetch<CursorPage<Organization>>(`/organizations${suffix}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
}

export function createOrganization(
  accessToken: string,
  input: CreateOrganizationInput,
): Promise<Organization> {
  return apiFetch<Organization>('/organizations', {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}` },
    body: JSON.stringify(input),
  });
}

export function retrieveOrganization(accessToken: string, organizationId: string): Promise<Organization> {
  return apiFetch<Organization>(`/organizations/${organizationId}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
}

export function updateOrganization(
  accessToken: string,
  organizationId: string,
  name: string,
): Promise<Organization> {
  return apiFetch<Organization>(`/organizations/${organizationId}`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${accessToken}` },
    body: JSON.stringify({ name }),
  });
}

export function deleteOrganization(accessToken: string, organizationId: string): Promise<void> {
  return apiFetch<void>(`/organizations/${organizationId}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${accessToken}` },
  });
}

// ---------------------------------------------------------------------------
// Members (phase 4 §4.2, D4)
// ---------------------------------------------------------------------------

export function listMembers(
  accessToken: string,
  organizationId: string,
  query: { limit?: number; cursor?: string } = {},
): Promise<CursorPage<OrganizationMember>> {
  const params = new URLSearchParams();
  if (query.limit !== undefined) params.set('limit', String(query.limit));
  if (query.cursor) params.set('cursor', query.cursor);
  const suffix = params.size > 0 ? `?${params}` : '';
  return apiFetch<CursorPage<OrganizationMember>>(`/organizations/${organizationId}/members${suffix}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
}

export function updateMember(
  accessToken: string,
  organizationId: string,
  userId: string,
  role: Role,
): Promise<OrganizationMember> {
  return apiFetch<OrganizationMember>(`/organizations/${organizationId}/members/${userId}`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${accessToken}` },
    body: JSON.stringify({ role }),
  });
}

export function removeMember(accessToken: string, organizationId: string, userId: string): Promise<void> {
  return apiFetch<void>(`/organizations/${organizationId}/members/${userId}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${accessToken}` },
  });
}

// ---------------------------------------------------------------------------
// Invitations (phase 4 §4.2, D5/D6)
// ---------------------------------------------------------------------------

export function listInvitations(
  accessToken: string,
  organizationId: string,
  query: { limit?: number; cursor?: string } = {},
): Promise<CursorPage<Invitation>> {
  const params = new URLSearchParams();
  if (query.limit !== undefined) params.set('limit', String(query.limit));
  if (query.cursor) params.set('cursor', query.cursor);
  const suffix = params.size > 0 ? `?${params}` : '';
  return apiFetch<CursorPage<Invitation>>(`/organizations/${organizationId}/invitations${suffix}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
}

export function createInvitation(
  accessToken: string,
  organizationId: string,
  input: CreateInvitationInput,
): Promise<Invitation> {
  return apiFetch<Invitation>(`/organizations/${organizationId}/invitations`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}` },
    body: JSON.stringify(input),
  });
}

export function cancelInvitation(
  accessToken: string,
  organizationId: string,
  invitationId: string,
): Promise<void> {
  return apiFetch<void>(`/organizations/${organizationId}/invitations/${invitationId}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${accessToken}` },
  });
}

export function acceptInvitation(accessToken: string, invitationId: string): Promise<OrganizationMember> {
  return apiFetch<OrganizationMember>(`/invitations/${invitationId}/accept`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}` },
  });
}