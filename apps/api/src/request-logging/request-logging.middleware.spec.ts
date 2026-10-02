import { EventEmitter } from 'node:events';

import { Test } from '@nestjs/testing';

import { RequestLoggingMiddleware } from './request-logging.middleware';
import { RequestLogStoreService } from './request-log-store.service';
import type { RequestLogRecord } from './request-log-record';

/** Minimal express-shaped doubles: the middleware only reads these members. */
interface FakeResponse extends EventEmitter {
  statusCode: number;
}

function createResponse(statusCode = 200): FakeResponse {
  const response = new EventEmitter() as FakeResponse;
  response.statusCode = statusCode;
  return response;
}

interface FakeRequest {
  method: string;
  originalUrl: string;
  headers: Record<string, string | undefined>;
  id?: unknown;
  authUser?: unknown;
  project?: unknown;
  organizationMembership?: unknown;
  apiKey?: unknown;
  query?: unknown;
}

function createRequest(overrides: Partial<FakeRequest> = {}): FakeRequest {
  return {
    method: 'GET',
    originalUrl: '/api/v1/customers',
    headers: {},
    ...overrides,
  };
}

describe('RequestLoggingMiddleware (phase 11 §4.2/§5.2, D3/D7)', () => {
  let middleware: RequestLoggingMiddleware;
  let store: { write: jest.Mock };
  let next: jest.Mock;

  beforeEach(async () => {
    store = { write: jest.fn().mockResolvedValue(undefined) };
    next = jest.fn();

    const moduleRef = await Test.createTestingModule({
      providers: [RequestLoggingMiddleware, { provide: RequestLogStoreService, useValue: store }],
    }).compile();
    middleware = moduleRef.get(RequestLoggingMiddleware);
  });

  function writtenRecords(): RequestLogRecord[] {
    return store.write.mock.calls.map(([record]) => record as RequestLogRecord);
  }

  /** Runs the middleware and completes the response as express would. */
  function finish(request: FakeRequest, statusCode = 200): FakeResponse {
    const response = createResponse(statusCode);
    middleware.use(request as never, response as never, next as never);
    response.emit('finish');
    return response;
  }

  it('writes exactly one record once the response completes, and never before', () => {
    const request = createRequest();
    const response = createResponse();

    middleware.use(request as never, response as never, next as never);
    expect(store.write).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledTimes(1);

    response.emit('finish');
    expect(store.write).toHaveBeenCalledTimes(1);
    // A second `finish` must not double-write: one row per request (rule 1).
    response.emit('finish');
    expect(store.write).toHaveBeenCalledTimes(1);
  });

  it('stores the server-assigned request id that the response header carries (rule 2)', () => {
    const request = createRequest({ id: `req_${'b'.repeat(32)}` });
    finish(request);

    expect(writtenRecords()[0].request_id).toBe(`req_${'b'.repeat(32)}`);
  });

  it('assigns a canonical request id when the ingress has not set one', () => {
    const request = createRequest();
    finish(request);

    const record = writtenRecords()[0];
    expect(record.request_id).toMatch(/^req_[0-9a-f]{32}$/);
    // The same id is the one the request carries afterwards, so the stdout log,
    // the error envelope and this row all correlate (rule 3).
    expect(request.id).toBe(record.request_id);
  });

  it('captures method, path without query string, status and duration', () => {
    const request = createRequest({ method: 'POST', originalUrl: '/api/v1/payments?limit=10' });

    finish(request, 201);

    expect(writtenRecords()[0]).toMatchObject({
      method: 'POST',
      path: '/api/v1/payments',
      status_code: 201,
    });
    expect(writtenRecords()[0].duration_ms).toBeGreaterThanOrEqual(0);
  });

  it('records rejected requests too — a 401 produces a null-scope row', () => {
    finish(createRequest(), 401);

    expect(writtenRecords()[0]).toMatchObject({
      status_code: 401,
      project_id: null,
      organization_id: null,
      user_id: null,
      api_key_id: null,
      environment: null,
    });
  });

  it('reads the scope the guards resolved by the time the response finished (rule 5)', () => {
    const request = createRequest();
    const response = createResponse(403);

    middleware.use(request as never, response as never, next as never);
    // Simulate guards running after the middleware and failing at the capability
    // check: the record must still carry the partial scope that authorized it.
    request.project = { project_id: '11111111-1111-4111-8111-111111111111', organization_id: '22222222-2222-4222-8222-222222222222' };
    request.organizationMembership = { organization_id: '22222222-2222-4222-8222-222222222222', role: 'viewer' };
    request.authUser = { id: '33333333-3333-4333-8333-333333333333' };
    request.query = { environment: 'live' };
    response.emit('finish');

    expect(writtenRecords()[0]).toMatchObject({
      status_code: 403,
      project_id: '11111111-1111-4111-8111-111111111111',
      organization_id: '22222222-2222-4222-8222-222222222222',
      user_id: '33333333-3333-4333-8333-333333333333',
      environment: 'live',
    });
  });

  it('takes the environment from the API key in API-key mode, not from the query', () => {
    const request = createRequest({
      query: { environment: 'live' },
      apiKey: {
        key_id: '44444444-4444-4444-8444-444444444444',
        project_id: '11111111-1111-4111-8111-111111111111',
        organization_id: '22222222-2222-4222-8222-222222222222',
        environment: 'test',
      },
    });

    finish(request);

    expect(writtenRecords()[0]).toMatchObject({
      project_id: '11111111-1111-4111-8111-111111111111',
      api_key_id: '44444444-4444-4444-8444-444444444444',
      user_id: null,
      environment: 'test',
    });
  });

  it('never attaches a listener — and never writes — outside the API prefix (D7)', () => {
    for (const url of ['/health/live', '/health/ready', '/docs', '/', '/api/v10/customers']) {
      const response = createResponse();
      middleware.use(createRequest({ originalUrl: url }) as never, response as never, next as never);
      expect(response.listenerCount('finish')).toBe(0);
      response.emit('finish');
    }

    expect(next).toHaveBeenCalledTimes(5);
    expect(store.write).not.toHaveBeenCalled();
  });

  it('never writes a CORS preflight (D7), but still passes it through', () => {
    const response = createResponse();
    middleware.use(
      createRequest({ method: 'OPTIONS', headers: { 'access-control-request-method': 'GET' } }) as never,
      response as never,
      next as never,
    );

    expect(next).toHaveBeenCalledTimes(1);
    expect(response.listenerCount('finish')).toBe(0);
    expect(store.write).not.toHaveBeenCalled();
  });

  it('keeps a failure of the record assembly off the response path', () => {
    const request = createRequest();
    const response = createResponse();
    middleware.use(request as never, response as never, next as never);

    // Force assembly to fail on the completion seam (here: reading the status).
    // The response has already been sent at this point; the listener must swallow
    // the failure instead of surfacing it as an unhandled 'error' event.
    Object.defineProperty(response, 'statusCode', {
      get() {
        throw new Error('boom');
      },
    });

    expect(() => response.emit('finish')).not.toThrow();
    expect(next).toHaveBeenCalledTimes(1);
    expect(store.write).not.toHaveBeenCalled();
  });
});
