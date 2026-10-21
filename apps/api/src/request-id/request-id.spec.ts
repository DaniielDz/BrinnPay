import { generateRequestId, resolveRequestId } from './request-id';

describe('generateRequestId', () => {
  it('produces the req_ scheme (phase 1 §7.8)', () => {
    const requestId = generateRequestId();
    expect(requestId).toMatch(/^req_[0-9a-f]{32}$/);
  });

  it('produces unique IDs', () => {
    expect(generateRequestId()).not.toBe(generateRequestId());
  });
});

describe('resolveRequestId', () => {
  it('assigns an ID when the request has none', () => {
    const request: { id?: string } = {};
    const requestId = resolveRequestId(request);
    expect(requestId).toMatch(/^req_/);
    expect(request.id).toBe(requestId);
  });

  it('reuses an existing request ID idempotently', () => {
    const request: { id?: string } = { id: 'req_existing' };
    expect(resolveRequestId(request)).toBe('req_existing');
  });

  it('ignores empty IDs', () => {
    const request: { id?: string } = { id: '' };
    const requestId = resolveRequestId(request);
    expect(requestId).toMatch(/^req_/);
  });
});