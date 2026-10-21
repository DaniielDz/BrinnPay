import {
  DEFAULT_FAILURE_CODE,
  DEFAULT_SIMULATION_INTENT,
  FAILURE_CODES,
  MAX_SIMULATION_SCENARIO_LENGTH,
  PAYMENT_SCENARIOS,
  isFailureCode,
  isPaymentScenario,
  parseSimulationScenario,
  scenarioColumnValue,
} from './payment-scenario';

describe('payment scenario model (phase 16 §4.2/§4.5, D1/D4; ADR-0031)', () => {
  describe('catalog', () => {
    it('is exactly the D4 catalog with `card_declined` as the default', () => {
      expect(FAILURE_CODES).toEqual(['card_declined', 'insufficient_funds', 'processing_timeout']);
      expect(DEFAULT_FAILURE_CODE).toBe('card_declined');
      expect(isFailureCode(DEFAULT_FAILURE_CODE)).toBe(true);
    });

    it('rejects anything outside the catalog', () => {
      expect(isFailureCode('declined')).toBe(false);
      expect(isFailureCode('')).toBe(false);
      expect(isFailureCode('CARD_DECLINED')).toBe(false);
      expect(isPaymentScenario('declined')).toBe(false);
      expect(isPaymentScenario('')).toBe(false);
    });

    it('exposes the closed scenario enum D1 (a) confirmed', () => {
      expect(PAYMENT_SCENARIOS).toEqual(['succeed', 'decline', 'timeout']);
      expect(isPaymentScenario('succeed')).toBe(true);
      expect(isPaymentScenario('decline')).toBe(true);
      expect(isPaymentScenario('timeout')).toBe(true);
    });

    it('every persisted representation fits the varchar(50) column (§7)', () => {
      const persisted = [
        null,
        ...PAYMENT_SCENARIOS,
        ...FAILURE_CODES.map((code) => scenarioColumnValue('decline', code)),
      ];
      for (const value of persisted) {
        expect(value === null || value.length <= MAX_SIMULATION_SCENARIO_LENGTH).toBe(true);
      }
    });
  });

  describe('scenarioColumnValue (the value written at creation)', () => {
    it('absent scenario ⇒ null, so an unflagged create keeps the pre-Phase 16 row shape', () => {
      expect(scenarioColumnValue(undefined)).toBeNull();
      expect(scenarioColumnValue(undefined, 'card_declined')).toBeNull();
    });

    it('explicit succeed and timeout store their closed-enum token', () => {
      expect(scenarioColumnValue('succeed')).toBe('succeed');
      expect(scenarioColumnValue('timeout')).toBe('timeout');
    });

    it('a decline always stores its resolved code — the catalog default when omitted', () => {
      expect(scenarioColumnValue('decline')).toBe('decline:card_declined');
      expect(scenarioColumnValue('decline', 'insufficient_funds')).toBe(
        'decline:insufficient_funds',
      );
      expect(scenarioColumnValue('decline', 'processing_timeout')).toBe(
        'decline:processing_timeout',
      );
    });

    it('never persists a code outside the catalog, even past the DTO boundary', () => {
      expect(scenarioColumnValue('decline', 'bogus' as 'card_declined')).toBe(
        'decline:card_declined',
      );
      // A decline code without a decline scenario has nowhere to go.
      expect(scenarioColumnValue('succeed', 'insufficient_funds')).toBe('succeed');
      expect(scenarioColumnValue('timeout', 'insufficient_funds')).toBe('timeout');
    });
  });

  describe('parseSimulationScenario (the value read by the sweep)', () => {
    it('null and an empty value are default success — the pre-Phase 16 rows', () => {
      expect(parseSimulationScenario(null)).toEqual(DEFAULT_SIMULATION_INTENT);
      expect(parseSimulationScenario(undefined)).toEqual(DEFAULT_SIMULATION_INTENT);
      expect(parseSimulationScenario('')).toEqual(DEFAULT_SIMULATION_INTENT);
    });

    it('round-trips every value scenarioColumnValue writes', () => {
      expect(parseSimulationScenario(scenarioColumnValue(undefined))).toEqual(
        DEFAULT_SIMULATION_INTENT,
      );
      expect(parseSimulationScenario(scenarioColumnValue('succeed'))).toEqual({
        scenario: 'succeed',
        failureCode: null,
      });
      expect(parseSimulationScenario(scenarioColumnValue('timeout'))).toEqual({
        scenario: 'timeout',
        failureCode: null,
      });
      for (const code of FAILURE_CODES) {
        expect(parseSimulationScenario(scenarioColumnValue('decline', code))).toEqual({
          scenario: 'decline',
          failureCode: code,
        });
      }
    });

    it('accepts a bare `decline` defensively with the catalog default', () => {
      expect(parseSimulationScenario('decline')).toEqual({
        scenario: 'decline',
        failureCode: DEFAULT_FAILURE_CODE,
      });
    });

    it('an unrecognized or unpersisted value is default success (§11.1)', () => {
      for (const raw of ['not-a-scenario', 'decline:bogus', 'DECLINE', 'sandbox', 'succeeded']) {
        expect(parseSimulationScenario(raw)).toEqual(DEFAULT_SIMULATION_INTENT);
      }
    });

    it('keeps the failure code null for every non-decline scenario (§4.3 rule 6)', () => {
      for (const scenario of PAYMENT_SCENARIOS) {
        const intent = parseSimulationScenario(scenarioColumnValue(scenario));
        if (scenario === 'decline') {
          expect(intent.failureCode).toBe(DEFAULT_FAILURE_CODE);
        } else {
          expect(intent.failureCode).toBeNull();
        }
      }
    });
  });
});
