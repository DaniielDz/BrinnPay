import {
  buildRequestLogRecord,
  isCorsPreflight,
  isRequestLogMethod,
  isUnderApiPrefix,
  MAX_REQUEST_LOG_PATH_LENGTH,
  REQUEST_LOG_METHODS,
  requestPathOf,
  resolveRequestLogScope,
  sanitizePath,
  type RequestLogCaptureInput,
  type RequestLogRecord,
  type RequestLogRequestContext,
} from './request-log-record';

const REQUEST_ID = `req_${'a'.repeat(32)}`;
const PROJECT_ID = '11111111-1111-4111-8111-111111111111';
const ORGANIZATION_ID = '22222222-2222-4222-8222-222222222222';
const USER_ID = '33333333-3333-4333-8333-333333333333';
const KEY_ID = '44444444-4444-4444-8444-444444444444';

function input(overrides: Partial<RequestLogCaptureInput> = {}): RequestLogCaptureInput {
  return {
    requestId: REQUEST_ID,
    method: 'GET',
    rawUrl: '/api/v1/customers',
    preflight: false,
    statusCode: 200,
    durationMs: 12.4,
    now: new Date('2026-10-01T00:00:00.000Z'),
    id: '55555555-5555-4555-8555-555555555555',
    request: {},
    ...overrides,
  };
}

/** The exact stored shape: any extra property here would be an allowlist leak. */
const CONTRACT_FIELDS = [
  'api_key_id',
  'created_at',
  'duration_ms',
  'environment',
  'id',
  'method',
  'organization_id',
  'path',
  'project_id',
  'request_id',
  'status_code',
  'user_id',
];

describe('request path rules (phase 11 D6/D7)', () => {
  it('strips the query string and falls back to "/" for an empty target', () => {
    expect(requestPathOf('/api/v1/payments?limit=10&cursor=abc')).toBe('/api/v1/payments');
    expect(requestPathOf('/api/v1')).toBe('/api/v1');
    expect(requestPathOf('')).toBe('/');
    expect(requestPathOf('?just-a-query')).toBe('/');
  });

  it('bounds the stored path to the column size', () => {
    const long = `/api/v1/${'x'.repeat(5000)}`;
    expect(sanitizePath(long)).toHaveLength(MAX_REQUEST_LOG_PATH_LENGTH);
    expect(sanitizePath('/api/v1/customers?limit=1')).toBe('/api/v1/customers');
  });

  it('recognises only the API prefix as persisted surface', () => {
    expect(isUnderApiPrefix('/api/v1')).toBe(true);
    expect(isUnderApiPrefix('/api/v1/customers')).toBe(true);
    expect(isUnderApiPrefix('/api/v10/customers')).toBe(false);
    expect(isUnderApiPrefix('/health/live')).toBe(false);
    expect(isUnderApiPrefix('/health/ready')).toBe(false);
    expect(isUnderApiPrefix('/docs')).toBe(false);
    expect(isUnderApiPrefix('/')).toBe(false);
  });

  it('recognises a CORS preflight only as an OPTIONS carrying the right header', () => {
    expect(isCorsPreflight('OPTIONS', { 'access-control-request-method': 'GET' })).toBe(true);
    // A real OPTIONS on an API route is part of the contract's method enum and
    // must still be recorded.
    expect(isCorsPreflight('OPTIONS', {})).toBe(false);
    expect(isCorsPreflight('GET', { 'access-control-request-method': 'GET' })).toBe(false);
    expect(isCorsPreflight('GET', undefined)).toBe(false);
  });

  it('accepts exactly the contract method enum', () => {
    for (const method of REQUEST_LOG_METHODS) {
      expect(isRequestLogMethod(method)).toBe(true);
      expect(isRequestLogMethod(method.toLowerCase())).toBe(true);
    }
    expect(isRequestLogMethod('TRACE')).toBe(false);
    expect(isRequestLogMethod('CONNECT')).toBe(false);
  });
});

describe('record assembly (phase 11 §4.2 rules 4/7)', () => {
  it('projects exactly the contract fields — nothing can widen the stored shape', () => {
    const record = buildRequestLogRecord(input({ request: { authUser: { id: USER_ID } } }));
    expect(record).not.toBeNull();
    expect(Object.keys(record as RequestLogRecord).sort()).toEqual(CONTRACT_FIELDS);
  });

  it('drops the query string, uppercases the method and rounds the duration', () => {
    const record = buildRequestLogRecord(
      input({ rawUrl: '/api/v1/payments?access_token=should-not-be-stored', method: 'post' }),
    );
    expect(record).toMatchObject({ method: 'POST', path: '/api/v1/payments', status_code: 200 });
    expect(record?.duration_ms).toBe(12);
    expect(record?.created_at.toISOString()).toBe('2026-10-01T00:00:00.000Z');
  });

  it('never records a negative duration', () => {
    expect(buildRequestLogRecord(input({ durationMs: -5 }))?.duration_ms).toBe(0);
  });

  it.each([
    ['outside the API prefix', { rawUrl: '/health/live' }],
    ['a CORS preflight', { preflight: true }],
    ['a method outside the contract enum', { method: 'TRACE' }],
  ])('returns null for %s (D7)', (_label, overrides) => {
    expect(buildRequestLogRecord(input(overrides))).toBeNull();
  });

  it('carries the ingress request id verbatim (rule 2)', () => {
    expect(buildRequestLogRecord(input())?.request_id).toBe(REQUEST_ID);
  });
});

describe('scope resolution (phase 11 §4.2 rule 5)', () => {
  it('API-key mode records project, organization, key and the key environment', () => {
    const request: RequestLogRequestContext = {
      apiKey: {
        key_id: KEY_ID,
        project_id: PROJECT_ID,
        organization_id: ORGANIZATION_ID,
        environment: 'live',
      },
    };
    expect(resolveRequestLogScope(request)).toEqual({
      project_id: PROJECT_ID,
      organization_id: ORGANIZATION_ID,
      user_id: null,
      api_key_id: KEY_ID,
      environment: 'live',
    });
  });

  it('a session on a project route records the resolved scope and a validated environment', () => {
    const request: RequestLogRequestContext = {
      authUser: { id: USER_ID },
      project: { project_id: PROJECT_ID, organization_id: ORGANIZATION_ID },
      organizationMembership: { organization_id: ORGANIZATION_ID, role: 'owner' },
      query: { environment: 'test' },
    };
    expect(resolveRequestLogScope(request)).toEqual({
      project_id: PROJECT_ID,
      organization_id: ORGANIZATION_ID,
      user_id: USER_ID,
      api_key_id: null,
      environment: 'test',
    });
  });

  it('a session without an environment carries none — and an unvalidated one is refused (D1)', () => {
    const base = {
      authUser: { id: USER_ID },
      project: { project_id: PROJECT_ID, organization_id: ORGANIZATION_ID },
    };
    expect(resolveRequestLogScope(base).environment).toBeNull();
    expect(resolveRequestLogScope({ ...base, query: { environment: 'staging' } }).environment).toBeNull();
    expect(resolveRequestLogScope({ ...base, query: { environment: '' } }).environment).toBeNull();
    expect(resolveRequestLogScope({ ...base, query: undefined }).environment).toBeNull();
  });

  it('an organization route records no project', () => {
    expect(
      resolveRequestLogScope({
        authUser: { id: USER_ID },
        organizationMembership: { organization_id: ORGANIZATION_ID, role: 'member' },
        query: { environment: 'live' },
      }),
    ).toEqual({
      project_id: null,
      organization_id: ORGANIZATION_ID,
      user_id: USER_ID,
      api_key_id: null,
      environment: null,
    });
  });

  it('an auth route records the caller only', () => {
    expect(resolveRequestLogScope({ authUser: { id: USER_ID } })).toEqual({
      project_id: null,
      organization_id: null,
      user_id: USER_ID,
      api_key_id: null,
      environment: null,
    });
  });

  it('an unauthenticated or rejected request records nothing (null scope)', () => {
    expect(resolveRequestLogScope({})).toEqual({
      project_id: null,
      organization_id: null,
      user_id: null,
      api_key_id: null,
      environment: null,
    });
  });

  it('a request rejected after partial resolution keeps the scope reached so far', () => {
    // 403: the project was loaded, membership validated, capability failed.
    expect(
      resolveRequestLogScope({
        project: { project_id: PROJECT_ID, organization_id: ORGANIZATION_ID },
        organizationMembership: { organization_id: ORGANIZATION_ID, role: 'viewer' },
      }),
    ).toEqual({
      project_id: PROJECT_ID,
      organization_id: ORGANIZATION_ID,
      user_id: null,
      api_key_id: null,
      environment: null,
    });
  });

  it('prefers the key environment over any session query, and ignores non-string scope values', () => {
    expect(
      resolveRequestLogScope({
        apiKey: { key_id: KEY_ID, project_id: PROJECT_ID, organization_id: ORGANIZATION_ID, environment: 'test' },
        query: { environment: 'live' },
      }).environment,
    ).toBe('test');

    // A payload-shaped object in a scope slot (hand-set by buggy code) yields
    // null columns instead of `[object Object]` reaching the database.
    expect(
      resolveRequestLogScope({ authUser: { nested: { id: USER_ID } } as unknown as { id: string } }).user_id,
    ).toBeNull();
  });

  it('an environment outside the catalog can never be recorded', () => {
    expect(
      resolveRequestLogScope({
        apiKey: { key_id: KEY_ID, project_id: PROJECT_ID, organization_id: ORGANIZATION_ID, environment: 'prod' },
      }).environment,
    ).toBeNull();
  });
});
