import type { AuditActor } from './audit-actions';

/**
 * The already-resolved request context audit capture reads (phase 12 §5.6
 * rule 3): the same scope objects the project guards hand to the domain
 * service. Structure-typed so both `PaymentsScope` (§5.4) and
 * `CustomersScope` (§5.5) satisfy it without importing either — no header,
 * body or path value is ever re-derived here.
 *
 * Session mode carries the authenticated user id the session guard attached;
 * API-key mode carries the key id (never the plaintext).
 */
export type AuditScope =
  | {
      mode: 'session';
      project: { readonly organization_id: string };
      readonly user_id: string;
    }
  | {
      mode: 'api_key';
      key: { readonly key_id: string; readonly organization_id: string };
    };

/**
 * Organization scope of a project-scoped action (§4.2 rule 3): the resource's
 * project's organization, taken from the verified request scope — the
 * requester can never steer an entry into a foreign tenant, because the scope
 * itself was resolved by the guard (§9 tenant isolation).
 */
export function organizationIdOfScope(scope: AuditScope): string {
  return scope.mode === 'session' ? scope.project.organization_id : scope.key.organization_id;
}

/**
 * Actor of a project-scoped action (§4.2 rule 4): session-driven → the user
 * that acted; API-key-driven → the key that acted. Never re-derived from
 * headers or bodies, and never the key's plaintext.
 */
export function actorOfScope(scope: AuditScope): AuditActor {
  return scope.mode === 'session'
    ? { type: 'user', id: scope.user_id }
    : { type: 'api_key', id: scope.key.key_id };
}

/**
 * The two values a session-only surface (organizations, api-keys, auth) must
 * pass alongside its mutation: who acted and the server-assigned id of the
 * triggering request (§4.2 rule 8). Assembled by the controller from context
 * the guards already resolved — never from headers or bodies.
 */
export interface AuditRequestContext {
  actor: AuditActor;
  request_id: string | null;
}

/** Convenience for session-only routes: the acting user is always a `user`. */
export function userActor(userId: string): AuditActor {
  return { type: 'user', id: userId };
}
