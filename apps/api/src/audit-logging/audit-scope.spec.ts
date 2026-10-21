import { actorOfScope, organizationIdOfScope, userActor, type AuditScope } from './audit-scope';

const ORG_ID = '0192f2a0-0000-7000-8000-00000000000a';
const USER_ID = '0192f2a0-0000-7000-8000-00000000000b';
const KEY_ID = '0192f2a0-0000-7000-8000-00000000000c';

describe('audit scope helpers (phase 12 §5.6, §9 tenant isolation)', () => {
  const sessionScope: AuditScope = {
    mode: 'session',
    project: { organization_id: ORG_ID },
    user_id: USER_ID,
  };

  const apiKeyScope: AuditScope = {
    mode: 'api_key',
    key: { key_id: KEY_ID, organization_id: ORG_ID },
  };

  it('takes organization scope from the guard-resolved project or key — never from input', () => {
    expect(organizationIdOfScope(sessionScope)).toBe(ORG_ID);
    expect(organizationIdOfScope(apiKeyScope)).toBe(ORG_ID);
  });

  it('derives the actor from verified context: user in session mode, key in API-key mode', () => {
    expect(actorOfScope(sessionScope)).toEqual({ type: 'user', id: USER_ID });
    expect(actorOfScope(apiKeyScope)).toEqual({ type: 'api_key', id: KEY_ID });
    // The API key id, never the plaintext key.
    expect(JSON.stringify(actorOfScope(apiKeyScope))).not.toContain('sk_');
  });

  it('session-only surfaces always act as the authenticated user (§5.3)', () => {
    expect(userActor(USER_ID)).toEqual({ type: 'user', id: USER_ID });
  });

  it('rejects neither mode silently: both scope shapes are accepted by the union', () => {
    for (const scope of [sessionScope, apiKeyScope]) {
      expect(typeof organizationIdOfScope(scope)).toBe('string');
      expect(actorOfScope(scope)).toHaveProperty('type');
    }
  });
});
