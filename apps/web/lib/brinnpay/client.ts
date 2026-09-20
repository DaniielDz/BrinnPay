/**
 * Minimal BrinnPay API client for the browser (phase 3 §4.2 login/register/
 * refresh/logout/me).
 *
 * The refresh cookie is `HttpOnly` and scoped to `/api/v1/auth`, so it travels
 * automatically with these requests; the access token is kept in memory by the
 * caller on `AuthProvider`.
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