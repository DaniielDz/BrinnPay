import {
  SIMULATED_ATTEMPT_REASONS,
  WEBHOOK_SIMULATION_ACTIONS,
  isWebhookSimulationAction,
  simulatedAttempt,
  simulationAction,
} from './webhook-simulation';

describe('webhook destination simulation (phase 16 §5, D5 (a); ADR-0032)', () => {
  describe('marker detection — exact segment match, never substring (§5.2 rule 7)', () => {
    it.each([
      'https://example.com/sandbox/fail',
      'https://example.com/sandbox/timeout',
      'https://example.com/sandbox/reject',
      'http://localhost:3000/sandbox/fail',
      'https://example.com/hooks/sandbox/fail',
      'https://example.com/sandbox/fail/',
      'https://example.com/sandbox/fail/anything',
    ])('detects the marker in %s', (url) => {
      expect(simulationAction(url)).not.toBeNull();
    });

    it.each([
      'https://example.com/failure-handler',
      'https://example.com/sandbox/webhook',
      'https://example.com/sandbox',
      'https://example.com/reject',
      'https://example.com/hooks/mysandbox/fail',
      'https://example.com/hooks/sandbox-fail',
      'https://example.com/hooks/sandbox/FAIL',
      'https://example.com/webhook?action=/sandbox/fail',
      'https://example.com/webhook?path=sandbox/timeout',
      'https://example.com/webhook#/sandbox/reject',
      'https://sandbox.example.com/hook',
      'https://example.com/sandbox/give-me-a-429',
    ])('never simulates %s', (url) => {
      expect(simulationAction(url)).toBeNull();
      expect(simulatedAttempt(url)).toBeNull();
    });

    it('ignores the query string even when it spells the marker out', () => {
      expect(simulationAction('https://example.com/h?x=/sandbox/fail')).toBeNull();
      expect(simulatedAttempt('https://example.com/h?x=/sandbox/fail')).toBeNull();
    });

    it('degrades to "attempt normally" for an unparseable URL rather than simulating', () => {
      expect(simulationAction('not a url')).toBeNull();
      expect(simulatedAttempt('not a url')).toBeNull();
    });

    it('exposes exactly the three documented actions', () => {
      expect(WEBHOOK_SIMULATION_ACTIONS).toEqual(['fail', 'timeout', 'reject']);
      expect(isWebhookSimulationAction('fail')).toBe(true);
      expect(isWebhookSimulationAction('give-me-a-429')).toBe(false);
      expect(isWebhookSimulationAction('')).toBe(false);
    });
  });

  describe('classification (§5.2 rule 4)', () => {
    it('`fail` and `timeout` are retryable, `reject` is terminal on attempt 1', () => {
      expect(simulatedAttempt('https://example.com/sandbox/fail')).toMatchObject({
        kind: 'retry',
        responseStatus: null,
        retryAfter: null,
      });
      expect(simulatedAttempt('https://example.com/sandbox/timeout')).toMatchObject({
        kind: 'retry',
        responseStatus: null,
        retryAfter: null,
      });
      expect(simulatedAttempt('https://example.com/sandbox/reject')).toMatchObject({
        kind: 'failed',
        responseStatus: null,
        retryAfter: null,
      });
    });

    it('records only a fixed, sanitized summary — never anything derived from the URL (§5.2 rule 3)', () => {
      for (const action of WEBHOOK_SIMULATION_ACTIONS) {
        const outcome = simulatedAttempt(`https://host.invalid/sandbox/${action}`);
        expect(outcome?.reason).toBe(SIMULATED_ATTEMPT_REASONS[action]);
        expect(outcome?.reason).toMatch(/\(sandbox\)$/);
        // Nothing about the destination leaks into what is stored or logged.
        expect(outcome?.reason).not.toContain('host.invalid');
        expect(outcome?.reason).not.toContain('https://');
      }
      expect(SIMULATED_ATTEMPT_REASONS).toEqual({
        fail: 'simulated network error (sandbox)',
        timeout: 'simulated request timeout (sandbox)',
        reject: 'simulated rejection (sandbox)',
      });
    });
  });
});
