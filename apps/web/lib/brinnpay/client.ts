/**
 * Minimal BrinnPay API client for the browser (phases 3–6: session auth, the
 * organizations/RBAC surface, projects, API keys, and customers).
 *
 * The refresh cookie is `HttpOnly` and scoped to `/api/v1/auth`, so it travels
 * automatically with these requests; the access token is kept in memory by the
 * caller on `AuthProvider`. Org-scoped requests pass the token explicitly via
 * `Authorization` (phase 4 §4.3; API keys arrive in Phase 5; customers in
 * Phase 6 — the dashboard always talks to the API with a session JWT, never
 * with an API key).
 *
 * `NEXT_PUBLIC_API_BASE_URL` allows pointing at the API (e.g.
 * `http://localhost:3000/api/v1` during local development). Defaults to the
 * local development API (phase 3 §5.2.6).
 */
import { captureRateLimit, formatDelay, retryAfterSecondsFor } from './rate-limit';
import { recoverSession } from './session';

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

/** The configured API base URL (public configuration, safe to display). */
export function getApiBaseUrl(): string {
  return API_BASE_URL;
}

export class ApiClientError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly requestId?: string,
    /** Seconds the API asked the caller to wait (`Retry-After`), when given. */
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = 'ApiClientError';
  }
}

/** `Retry-After` is published on 429 only (phase 13 §4.4). */
const RETRY_AFTER_HEADER = 'Retry-After';

/**
 * The single error-presentation rule of the application (phase 14 §7.3, D6).
 *
 * Every page renders `ApiClientError.message` in a `role="alert"` element, so
 * the wording is composed here — once — instead of being passed through per
 * page:
 *
 * - `429` is a **retryable, transient** condition carrying the indicated delay;
 *   it never reads as an authorization, session or data problem (phase 13
 *   handover).
 * - A mid-session `401` reads as re-authenticate (the refresh/retry already
 *   ran in `apiFetch`; a failed refresh redirects to `/login`).
 * - `403` reads as a permission state, `404`/`400`/`409`/`422` keep the API's
 *   message (it is the reason for the refusal), `5xx` is a generic retryable
 *   failure. No stack traces or internals, ever.
 * - The API's `request_id` is appended when the envelope provides it
 *   (`docs/api-conventions.md` §7 — issue-reporting flow).
 */
function composeErrorMessage(
  status: number,
  code: string,
  apiMessage: string | undefined,
  requestId: string | undefined,
  retryAfterSeconds: number | undefined,
  isSessionRoute: boolean,
): string {
  const withRequestId = (text: string): string =>
    requestId ? `${text} (request id: ${requestId})` : text;

  if (status === 429 || code === 'RATE_LIMITED') {
    const base = 'Too many requests — this is temporary.';
    if (retryAfterSeconds === undefined || retryAfterSeconds === null) {
      return `${base} Please wait a moment and try again.`;
    }
    if (retryAfterSeconds <= 0) return `${base} You can try again now.`;
    return `${base} Try again in ${formatDelay(retryAfterSeconds)}.`;
  }

  if (status === 401 && !isSessionRoute) {
    return withRequestId('Your session has expired. Please sign in again.');
  }

  if (status === 403) {
    return withRequestId(apiMessage ?? 'You do not have permission to perform this action.');
  }

  if (status >= 500) {
    // Fixed wording: a 5xx envelope message is never forwarded to the UI, so
    // no future server-side detail can leak through this presentation layer
    // (the API already sanitizes — this is the client's own backstop).
    return withRequestId('The request failed. Please try again.');
  }

  return withRequestId(apiMessage ?? `Request failed with status ${status}`);
}

async function apiFetch<T>(path: string, init: RequestInit = {}, retried = false): Promise<T> {
  const isSessionRoute = path.startsWith('/auth/');
  const method = (init.method ?? 'GET').toUpperCase();
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(init.headers as Record<string, string> | undefined),
  };

  // Throttled action (phase 14 §7.4): while the API-indicated delay runs, the
  // same method+path fails fast with the retryable error instead of re-hitting
  // the limit — the action is disabled for exactly the indicated delay, and
  // every attempt reports the remaining wait. Session routes are never gated.
  if (!retried && !isSessionRoute) {
    const blockedFor = retryAfterSecondsFor(path, { method });
    if (blockedFor !== null) {
      throw new ApiClientError(
        429,
        'RATE_LIMITED',
        composeErrorMessage(429, 'RATE_LIMITED', undefined, undefined, blockedFor, false),
        undefined,
        blockedFor,
      );
    }
  }

  let response: Response;
  try {
    response = await fetch(`${API_BASE_URL}${path}`, {
      ...init,
      credentials: 'include',
      headers,
    });
  } catch {
    // Network/parse failure: generic and retryable, never internals (§7.3).
    throw new ApiClientError(
      0,
      'NETWORK_ERROR',
      'The request could not be completed. Check your connection and try again.',
      undefined,
    );
  }

  // Budget + throttle bookkeeping (§7.4): presentation data only, silent when
  // the response carries no rate-limit headers, and the throttle is armed by a
  // `429` alone so another status's `Retry-After` never masks its real error.
  captureRateLimit(path, response.headers, { status: response.status, method });

  const retryAfterHeader = response.headers.get(RETRY_AFTER_HEADER);
  const retryAfterSeconds =
    retryAfterHeader === null ? undefined : (Number.parseInt(retryAfterHeader, 10) || 0);

  if (response.status === 204) {
    return undefined as T;
  }

  const body = (await response.json().catch(() => null)) as ApiErrorEnvelope | T | null;

  if (!response.ok) {
    const envelope = body as ApiErrorEnvelope | null;
    const code = envelope?.error?.code ?? 'UNKNOWN_ERROR';
    const apiMessage = envelope?.error?.message;
    const requestId = envelope?.error?.request_id;

    // Unauthenticated mid-session (§7.3): attempt the refresh flow once and
    // retry with the fresh token; a failed refresh clears the session so the
    // existing guard redirects to `/login`.
    if (response.status === 401 && !retried && !isSessionRoute) {
      const token = await recoverSession();
      if (token !== null) {
        return apiFetch<T>(path, { ...init, headers: { ...headers, Authorization: `Bearer ${token}` } }, true);
      }
    }

    throw new ApiClientError(
      response.status,
      code,
      composeErrorMessage(response.status, code, apiMessage, requestId, retryAfterSeconds, isSessionRoute),
      requestId,
      retryAfterSeconds,
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

// ---------------------------------------------------------------------------
// Projects (phase 5 §4.2)
// ---------------------------------------------------------------------------

/** Project environments: lowercase API values (`test`/`live`), uppercase in
 *  UI copy (`TEST`/`LIVE`) and in the key prefixes (`sk_test_…`/`sk_live_…`).
 *  A project always supports both; the API derives `environments` (D6). */
export type Environment = 'test' | 'live';

export function isEnvironment(value: string): value is Environment {
  return value === 'test' || value === 'live';
}

export interface Project {
  id: string;
  organization_id: string;
  name: string;
  created_at: string;
  updated_at: string;
  environments: Environment[];
}

export interface CreateProjectInput {
  organization_id: string;
  name: string;
}

export function listProjects(
  accessToken: string,
  query: { limit?: number; cursor?: string } = {},
): Promise<CursorPage<Project>> {
  const params = new URLSearchParams();
  if (query.limit !== undefined) params.set('limit', String(query.limit));
  if (query.cursor) params.set('cursor', query.cursor);
  const suffix = params.size > 0 ? `?${params}` : '';
  return apiFetch<CursorPage<Project>>(`/projects${suffix}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
}

export function createProject(accessToken: string, input: CreateProjectInput): Promise<Project> {
  return apiFetch<Project>('/projects', {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}` },
    body: JSON.stringify(input),
  });
}

export function retrieveProject(accessToken: string, projectId: string): Promise<Project> {
  return apiFetch<Project>(`/projects/${projectId}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
}

export function updateProject(accessToken: string, projectId: string, name: string): Promise<Project> {
  return apiFetch<Project>(`/projects/${projectId}`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${accessToken}` },
    body: JSON.stringify({ name }),
  });
}

export function deleteProject(accessToken: string, projectId: string): Promise<void> {
  return apiFetch<void>(`/projects/${projectId}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${accessToken}` },
  });
}

// ---------------------------------------------------------------------------
// API keys (phase 5 §4.2/§4.5)
// ---------------------------------------------------------------------------

/** `ApiKey` as contracted: metadata only — the plaintext credential never
 *  appears after creation (the server stores only its hash). */
export interface ApiKey {
  id: string;
  project_id: string;
  environment: Environment;
  created_at: string;
  revoked_at: string | null;
}

/** `ApiKeyCreated`: the `key` field carries the plaintext exactly once. */
export interface ApiKeyCreated extends ApiKey {
  key: string;
}

export function listApiKeys(
  accessToken: string,
  projectId: string,
  query: { limit?: number; cursor?: string } = {},
): Promise<CursorPage<ApiKey>> {
  const params = new URLSearchParams();
  if (query.limit !== undefined) params.set('limit', String(query.limit));
  if (query.cursor) params.set('cursor', query.cursor);
  const suffix = params.size > 0 ? `?${params}` : '';
  return apiFetch<CursorPage<ApiKey>>(`/projects/${projectId}/api-keys${suffix}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
}

export function createApiKey(
  accessToken: string,
  projectId: string,
  environment: Environment,
): Promise<ApiKeyCreated> {
  return apiFetch<ApiKeyCreated>(`/projects/${projectId}/api-keys`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}` },
    body: JSON.stringify({ environment }),
  });
}

export function revokeApiKey(accessToken: string, projectId: string, apiKeyId: string): Promise<void> {
  return apiFetch<void>(`/projects/${projectId}/api-keys/${apiKeyId}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${accessToken}` },
  });
}

// ---------------------------------------------------------------------------
// Customers (phase 6 §4.2/§5.2)
// ---------------------------------------------------------------------------

/** `Customer` as contracted (phase 6 §4.2): identity is the UUIDv7 `id`;
 *  duplicate emails are permitted within a project/environment (D1). */
export interface Customer {
  id: string;
  project_id: string;
  environment: Environment;
  email: string;
  name: string | null;
  metadata: Record<string, string>;
  created_at: string;
  updated_at: string;
}

/** `CustomerCreate` (phase 6 §4.2): `environment` is required — the page
 *  always passes the shell-selected environment (TEST/LIVE data is never
 *  mixed, D2). `name`/`metadata` are optional; `metadata` is a flat string
 *  map (D6). */
export interface CreateCustomerInput {
  environment: Environment;
  email: string;
  name?: string;
  metadata?: Record<string, string>;
}

/** `CustomerUpdate` (phase 6 §4.2): partial update of `email`/`name`/
 *  `metadata` — only provided fields change. The contract rejects explicit
 *  `null` (MVP: clearing `name` is unsupported, D7), so callers omit a
 *  cleared/empty field rather than sending `null`. */
export interface UpdateCustomerInput {
  email?: string;
  name?: string;
  metadata?: Record<string, string>;
}

export interface ListCustomersQuery {
  environment?: Environment;
  search?: string;
  limit?: number;
  cursor?: string;
}

export function listCustomers(
  accessToken: string,
  projectId: string,
  query: ListCustomersQuery = {},
): Promise<CursorPage<Customer>> {
  const params = new URLSearchParams();
  if (query.environment !== undefined) params.set('environment', query.environment);
  if (query.search) params.set('search', query.search);
  if (query.limit !== undefined) params.set('limit', String(query.limit));
  if (query.cursor) params.set('cursor', query.cursor);
  const suffix = params.size > 0 ? `?${params}` : '';
  return apiFetch<CursorPage<Customer>>(`/projects/${projectId}/customers${suffix}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
}

export function createCustomer(
  accessToken: string,
  projectId: string,
  input: CreateCustomerInput,
): Promise<Customer> {
  return apiFetch<Customer>(`/projects/${projectId}/customers`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}` },
    body: JSON.stringify(input),
  });
}

export function retrieveCustomer(
  accessToken: string,
  projectId: string,
  customerId: string,
): Promise<Customer> {
  return apiFetch<Customer>(`/projects/${projectId}/customers/${customerId}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
}

export function updateCustomer(
  accessToken: string,
  projectId: string,
  customerId: string,
  input: UpdateCustomerInput,
): Promise<Customer> {
  return apiFetch<Customer>(`/projects/${projectId}/customers/${customerId}`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${accessToken}` },
    body: JSON.stringify(input),
  });
}

export function deleteCustomer(accessToken: string, projectId: string, customerId: string): Promise<void> {
  return apiFetch<void>(`/projects/${projectId}/customers/${customerId}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${accessToken}` },
  });
}

// ---------------------------------------------------------------------------
// Payments (phase 7 §4.2/§5.2; phase 16 §4.2/§4.5 scenario fields)
// ---------------------------------------------------------------------------

/**
 * The closed create-time scenario catalog (phase 16 §4.2, D1 (a)).
 *
 * Mirrors the API's `PAYMENT_SCENARIOS` constant so the browser can render a
 * select whose options are exactly the values the boundary accepts — the API
 * remains the enforcement point; this is presentation and typing only. Absent
 * (or `succeed`) is today's default-success behavior.
 */
export const PAYMENT_SCENARIOS = ['succeed', 'decline', 'timeout'] as const;
export type PaymentScenario = (typeof PAYMENT_SCENARIOS)[number];

/** The phase 16 §4.5 failure-code catalog (D4), in catalog order. */
export const FAILURE_CODES = ['card_declined', 'insufficient_funds', 'processing_timeout'] as const;
export type FailureCode = (typeof FAILURE_CODES)[number];

/** Catalog default when `scenario: "decline"` omits `failure_code`. */
export const DEFAULT_FAILURE_CODE: FailureCode = 'card_declined';

export function isPaymentScenario(value: string): value is PaymentScenario {
  return (PAYMENT_SCENARIOS as readonly string[]).includes(value);
}

export function isFailureCode(value: string): value is FailureCode {
  return (FAILURE_CODES as readonly string[]).includes(value);
}

/** `Payment` as contracted (phase 7 §4.2, extended by phase 16): the
 *  simulation lifetime, `amount` as a decimal string (`MoneyAmount`,
 *  ADR-0002), `currency` always `usd` (ADR-0003), and `failure_code` — a
 *  phase 16 catalog value when `status` is `failed`, `null` otherwise (the
 *  create-time `scenario` itself is deliberately not projected, D6 (a)).
 *  `status` advances automatically on read. */
export interface Payment {
  id: string;
  project_id: string;
  environment: Environment;
  customer_id: string;
  amount: string;
  currency: 'usd';
  status: 'pending' | 'processing' | 'succeeded' | 'failed';
  failure_code: string | null;
  description: string | null;
  created_at: string;
  updated_at: string;
}

export function isTerminalPayment(payment: Payment): boolean {
  return payment.status === 'succeeded' || payment.status === 'failed';
}

/** A customer of the same (project, environment) to scope the create form. */
export interface PaymentCustomerOption {
  id: string;
  email: string;
  name: string | null;
}

/** `PaymentCreate` (phase 7 §4.2, extended by phase 16 §4.2): environment
 *  (required — the page always passes the shell-selected environment, D1),
 *  customer_id, amount and currency; `description` optional. `scenario` and
 *  `failure_code` are the optional sandbox fields — `failure_code` is only
 *  sent with `scenario: "decline"`, which is the validity rule the API
 *  enforces at the boundary. */
export interface CreatePaymentInput {
  environment: Environment;
  customer_id: string;
  amount: string;
  currency: 'usd';
  description?: string;
  scenario?: PaymentScenario;
  failure_code?: FailureCode;
}

export interface ListPaymentsQuery {
  environment?: Environment;
  limit?: number;
  cursor?: string;
}

export function listPayments(
  accessToken: string,
  projectId: string,
  query: ListPaymentsQuery = {},
): Promise<CursorPage<Payment>> {
  const params = new URLSearchParams();
  if (query.environment !== undefined) params.set('environment', query.environment);
  if (query.limit !== undefined) params.set('limit', String(query.limit));
  if (query.cursor) params.set('cursor', query.cursor);
  const suffix = params.size > 0 ? `?${params}` : '';
  return apiFetch<CursorPage<Payment>>(`/projects/${projectId}/payments${suffix}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
}

export function createPayment(
  accessToken: string,
  projectId: string,
  input: CreatePaymentInput,
): Promise<Payment> {
  return apiFetch<Payment>(`/projects/${projectId}/payments`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}` },
    body: JSON.stringify(input),
  });
}

export function retrievePayment(
  accessToken: string,
  projectId: string,
  paymentId: string,
): Promise<Payment> {
  return apiFetch<Payment>(`/projects/${projectId}/payments/${paymentId}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
}

// Refunds are always addressed through their parent payment (phase 9).
export interface Refund {
  id: string;
  payment_id: string;
  project_id: string;
  environment: Environment;
  amount: string;
  currency: 'usd';
  status: 'pending' | 'processing' | 'succeeded' | 'failed';
  reason: string | null;
  created_at: string;
  updated_at: string;
}

export function listRefunds(
  accessToken: string,
  paymentId: string,
  query: { limit?: number; cursor?: string } = {},
): Promise<CursorPage<Refund>> {
  const params = new URLSearchParams();
  if (query.limit !== undefined) params.set('limit', String(query.limit));
  if (query.cursor) params.set('cursor', query.cursor);
  return apiFetch<CursorPage<Refund>>(`/payments/${paymentId}/refunds${params.size ? `?${params}` : ''}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
}

export function createRefund(
  accessToken: string,
  paymentId: string,
  input: { amount?: string; currency?: 'usd'; reason?: string },
): Promise<Refund> {
  return apiFetch<Refund>(`/payments/${paymentId}/refunds`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}` },
    body: JSON.stringify(input),
  });
}

export function retrieveRefund(
  accessToken: string,
  paymentId: string,
  refundId: string,
): Promise<Refund> {
  return apiFetch<Refund>(`/payments/${paymentId}/refunds/${refundId}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
}

// ---------------------------------------------------------------------------
// Webhooks (phase 10 §4.4/§7)
// ---------------------------------------------------------------------------

/** The closed webhook event catalog (D1). The API rejects anything else. */
export const WEBHOOK_EVENT_TYPES = [
  'payment.created',
  'payment.succeeded',
  'payment.failed',
  'refund.created',
] as const;

export type WebhookEventType = (typeof WEBHOOK_EVENT_TYPES)[number];

/** `WebhookDeliveryStatus` (phase 10 §5.1/D4). */
export type WebhookDeliveryStatus = 'pending' | 'delivered' | 'failed';

export interface WebhookEndpoint {
  id: string;
  project_id: string;
  environment: Environment;
  url: string;
  event_types: WebhookEventType[];
  enabled: boolean;
  created_at: string;
  updated_at: string;
}

/** The create response is the only place the signing secret ever appears (D8). */
export interface WebhookEndpointCreated extends WebhookEndpoint {
  signing_secret: string;
}

export interface CreateWebhookEndpointInput {
  environment: Environment;
  url: string;
  event_types: WebhookEventType[];
  enabled?: boolean;
}

export interface UpdateWebhookEndpointInput {
  url?: string;
  event_types?: WebhookEventType[];
  enabled?: boolean;
}

/** The stored outbound envelope, exactly as delivered (phase 1 §9.5). */
export interface WebhookEvent {
  id: string;
  project_id: string;
  environment: Environment;
  type: WebhookEventType;
  data: Record<string, unknown>;
  created_at: string;
}

export interface WebhookDelivery {
  id: string;
  endpoint_id: string;
  event_id: string;
  status: WebhookDeliveryStatus;
  attempts: number;
  response_status: number | null;
  last_error: string | null;
  next_attempt_at: string | null;
  is_replay: boolean;
  created_at: string;
  updated_at: string;
}

export interface ListWebhookEndpointsQuery {
  environment?: Environment;
  limit?: number;
  cursor?: string;
}

/** `type` is the D15 event-type filter; the API answers 400 for a value
 *  outside the catalog rather than matching nothing. */
export interface ListWebhookEventsQuery {
  environment?: Environment;
  type?: WebhookEventType;
  limit?: number;
  cursor?: string;
}

/** `status` is the D15 delivery-status filter. */
export interface ListWebhookDeliveriesQuery {
  status?: WebhookDeliveryStatus;
  limit?: number;
  cursor?: string;
}

/** Serializes an optional filter set, skipping absent and empty values. */
function listQuery(query: Record<string, string | number | undefined>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== '') params.set(key, String(value));
  }
  return params.size > 0 ? `?${params}` : '';
}

export function listWebhookEndpoints(
  accessToken: string,
  projectId: string,
  query: ListWebhookEndpointsQuery = {},
): Promise<CursorPage<WebhookEndpoint>> {
  return apiFetch<CursorPage<WebhookEndpoint>>(
    `/projects/${projectId}/webhook-endpoints${listQuery({ ...query })}`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
  );
}

export function createWebhookEndpoint(
  accessToken: string,
  projectId: string,
  input: CreateWebhookEndpointInput,
): Promise<WebhookEndpointCreated> {
  return apiFetch<WebhookEndpointCreated>(`/projects/${projectId}/webhook-endpoints`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}` },
    body: JSON.stringify(input),
  });
}

export function updateWebhookEndpoint(
  accessToken: string,
  projectId: string,
  endpointId: string,
  input: UpdateWebhookEndpointInput,
): Promise<WebhookEndpoint> {
  return apiFetch<WebhookEndpoint>(`/projects/${projectId}/webhook-endpoints/${endpointId}`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${accessToken}` },
    body: JSON.stringify(input),
  });
}

export function deleteWebhookEndpoint(
  accessToken: string,
  projectId: string,
  endpointId: string,
): Promise<void> {
  return apiFetch<void>(`/projects/${projectId}/webhook-endpoints/${endpointId}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${accessToken}` },
  });
}

export function listWebhookEvents(
  accessToken: string,
  projectId: string,
  query: ListWebhookEventsQuery = {},
): Promise<CursorPage<WebhookEvent>> {
  return apiFetch<CursorPage<WebhookEvent>>(
    `/projects/${projectId}/webhook-events${listQuery({ ...query })}`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
  );
}

export function listWebhookDeliveries(
  accessToken: string,
  projectId: string,
  endpointId: string,
  query: ListWebhookDeliveriesQuery = {},
): Promise<CursorPage<WebhookDelivery>> {
  return apiFetch<CursorPage<WebhookDelivery>>(
    `/projects/${projectId}/webhook-endpoints/${endpointId}/deliveries${listQuery({ ...query })}`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
  );
}

/** Replay answers 202 with no body; it is repeatable by design (D12). */
export function replayWebhookEvent(
  accessToken: string,
  projectId: string,
  endpointId: string,
  eventId: string,
): Promise<void> {
  return apiFetch<void>(
    `/projects/${projectId}/webhook-endpoints/${endpointId}/events/${eventId}/replay`,
    { method: 'POST', headers: { Authorization: `Bearer ${accessToken}` } },
  );
}

// ---------------------------------------------------------------------------
// Request logs (phase 11 §4.3/§7)
// ---------------------------------------------------------------------------

/** `RequestLog` as contracted (phase 11 §4.3): request metadata only. No
 *  bodies, headers or query strings are ever stored (§14) or displayed, so
 *  nothing here can carry authorization material. Scope columns are nullable —
 *  an API-wide capability includes public/unauthenticated requests. The API is
 *  the authority: session tokens only, retention-bound, project-scoped. */
export interface RequestLog {
  id: string;
  request_id: string;
  project_id: string | null;
  organization_id: string | null;
  user_id: string | null;
  api_key_id: string | null;
  /** `null` when the request carried no validated environment (D1). */
  environment: Environment | null;
  method: string;
  path: string;
  status_code: number;
  /** Omitted when the response was never measured to completion. */
  duration_ms?: number;
  created_at: string;
}

/** D1: absent `environment` returns every record of the project (including
 *  environment-less ones); present, it narrows to that environment. `request_id`
 *  is an exact server-side lookup (D8) that answers an empty page rather than a
 *  404. Neither filter can address another project's records. */
export interface ListRequestLogsQuery {
  environment?: Environment;
  request_id?: string;
  limit?: number;
  cursor?: string;
}

export function listRequestLogs(
  accessToken: string,
  projectId: string,
  query: ListRequestLogsQuery = {},
): Promise<CursorPage<RequestLog>> {
  return apiFetch<CursorPage<RequestLog>>(
    `/projects/${projectId}/logs/requests${listQuery({ ...query })}`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
  );
}

// ---------------------------------------------------------------------------
// Audit logs (phase 12 §4.3/§8)
// ---------------------------------------------------------------------------

/** Allowlisted `data` scalars of an audit entry (phase 12 §4.2 rule 7): ids,
 *  roles, monetary amounts and the correlation `request_id` — never secrets,
 *  emails, headers, bodies or free text, so nothing here can carry PII beyond
 *  the bounded values the catalog permits. */
export type AuditData = Record<string, string | number | boolean | null>;

/** `AuditLogEntry` as contracted (phase 12, `logs.listAuditLogs`): an
 *  immutable, organization-scoped record of who did what, to which resource,
 *  when. `project_id`/`environment` are the additive D6 attribution columns —
 *  `null` (or absent) for organization- or user-scoped actions. */
export interface AuditLogEntry {
  id: string;
  organization_id: string;
  actor_type: 'user' | 'api_key';
  actor_id: string | null;
  action: string;
  resource_type: string;
  resource_id: string | null;
  project_id?: string | null;
  environment?: Environment | null;
  data?: AuditData;
  created_at: string;
}

/** D11: no filters exist beyond pagination — the contract has none, and the
 *  viewer mirrors that exactly. */
export interface ListAuditLogsQuery {
  limit?: number;
  cursor?: string;
}

/** Session-only, organization-scoped read (phase 12 §4.3): the dashboard
 *  always calls it with the session bearer; an API key never reads audit logs
 *  (the API answers 401). Scope is organization-wide — every project and both
 *  environments of the addressed tenant (D12) — ordered ascending by UUIDv7
 *  (D10) through the same cursor contract as every other list. Read-only: no
 *  operation creates, edits or deletes an entry. */
export function listAuditLogs(
  accessToken: string,
  organizationId: string,
  query: ListAuditLogsQuery = {},
): Promise<CursorPage<AuditLogEntry>> {
  return apiFetch<CursorPage<AuditLogEntry>>(
    `/organizations/${organizationId}/logs/audit${listQuery({ ...query })}`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
  );
}
