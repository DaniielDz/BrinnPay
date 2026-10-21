import { runPassword } from './run-password';

/**
 * Phase 17 §8 / F6: fixture passwords are generated per run and per suite and
 * always meet the Phase 3 D6 policy (`minLength 8`, `maxLength 128`,
 * NIST-style — no composition rules).
 */
describe('runPassword (phase 17 F6)', () => {
  it('generates a distinct, policy-compliant password per call', () => {
    const first = runPassword('conformance');
    const second = runPassword('journey');

    expect(first).not.toBe(second);
    for (const password of [first, second]) {
      expect(password.length).toBeGreaterThanOrEqual(8);
      expect(password.length).toBeLessThanOrEqual(128);
      expect(password).toMatch(/^[A-Za-z0-9_-]+$/);
    }
    // Prefixed so a leaked fixture can be attributed to its suite.
    expect(first.startsWith('conformance-')).toBe(true);
    expect(second.startsWith('journey-')).toBe(true);
  });
});
