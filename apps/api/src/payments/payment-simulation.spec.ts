import { DEFAULT_SIMULATION_INTENT, parseSimulationScenario } from './payment-scenario';
import { DEFAULT_SIMULATION_DELAYS, scheduledTransition } from './payment-simulation';
import type { PaymentStatus } from './payment-types';

const CREATED = new Date('2026-09-25T00:00:00.000Z');

function payment(status: PaymentStatus, createdAt: Date = CREATED) {
  return { status, createdAt };
}

/** `created_at + pending + settlement` — the first instant settlement is due. */
function settled(delays = DEFAULT_SIMULATION_DELAYS): Date {
  return new Date(CREATED.getTime() + delays.pendingDelayMs + delays.settlementDelayMs);
}

describe('payment simulation (phase 7 §4.6 D2, phase 16 §4.3/§4.5/§4.6)', () => {
  const delays = DEFAULT_SIMULATION_DELAYS;

  describe('scheduledTransition — timing', () => {
    it('pending: no transition before the pending delay elapses', () => {
      expect(
        scheduledTransition(
          payment('pending'),
          new Date(CREATED.getTime() + delays.pendingDelayMs - 1),
          delays,
        ),
      ).toBeNull();
    });

    it('pending → processing exactly at the pending delay', () => {
      expect(
        scheduledTransition(
          payment('pending'),
          new Date(CREATED.getTime() + delays.pendingDelayMs),
          delays,
        ),
      ).toEqual({ from: 'pending', to: 'processing', event: null });
    });

    it('processing: no transition before the settlement time', () => {
      expect(
        scheduledTransition(
          payment('processing'),
          new Date(CREATED.getTime() + delays.pendingDelayMs + delays.settlementDelayMs - 1),
          delays,
        ),
      ).toBeNull();
    });

    it('processing → succeeded (default scenario) at the settlement time', () => {
      expect(scheduledTransition(payment('processing'), settled(), delays)).toEqual({
        from: 'processing',
        to: 'succeeded',
        event: 'payment.succeeded',
      });
    });

    it('processing → succeeded when the scenario is explicitly `succeed`', () => {
      expect(scheduledTransition(payment('processing'), settled(), delays, 'succeed')).toEqual({
        from: 'processing',
        to: 'succeeded',
        event: 'payment.succeeded',
      });
    });
  });

  describe('scheduledTransition — decline (phase 16 §4.5)', () => {
    it('processing → failed carries the payment.failed event at the settlement edge', () => {
      expect(scheduledTransition(payment('processing'), settled(), delays, 'decline')).toEqual({
        from: 'processing',
        to: 'failed',
        event: 'payment.failed',
      });
    });

    it('decline fails on the NORMAL schedule — no timing special case (§4.3 rule 4)', () => {
      const before = new Date(settled().getTime() - 1);
      expect(scheduledTransition(payment('processing'), before, delays, 'decline')).toBeNull();
      expect(scheduledTransition(payment('processing'), settled(), delays, 'decline')).not.toBeNull();
    });

    it('pending → processing is NOT scenario-dependent (failure only ever fires at settlement)', () => {
      expect(
        scheduledTransition(
          payment('pending'),
          new Date(CREATED.getTime() + delays.pendingDelayMs),
          delays,
          'decline',
        ),
      ).toEqual({ from: 'pending', to: 'processing', event: null });
    });

    it('a decline still reaches processing before it can fail', () => {
      expect(scheduledTransition(payment('pending'), settled(), delays, 'decline')).toEqual({
        from: 'pending',
        to: 'processing',
        event: null,
      });
    });
  });

  describe('scheduledTransition — timeout never settles (phase 16 §4.6, D3 (a))', () => {
    it('pending still advances to processing on the pending delay', () => {
      expect(
        scheduledTransition(
          payment('pending'),
          new Date(CREATED.getTime() + delays.pendingDelayMs),
          delays,
          'timeout',
        ),
      ).toEqual({ from: 'pending', to: 'processing', event: null });
    });

    it('processing never settles, at or far beyond the settlement time', () => {
      expect(scheduledTransition(payment('processing'), settled(), delays, 'timeout')).toBeNull();
      expect(
        scheduledTransition(payment('processing'), new Date(settled().getTime() + 60_000), delays, 'timeout'),
      ).toBeNull();
    });

    it('never emits a terminal event from a pending timeout either', () => {
      const due = scheduledTransition(payment('pending'), settled(), delays, 'timeout');
      expect(due?.event).toBeNull();
      expect(due?.to).toBe('processing');
    });
  });

  describe('scheduledTransition — terminal states are absorbing', () => {
    it.each(['succeeded', 'failed'] as const)('%s never transitions', (status) => {
      const farFuture = new Date(CREATED.getTime() + 60_000);
      expect(scheduledTransition(payment(status), farFuture, delays)).toBeNull();
      expect(scheduledTransition(payment(status), farFuture, delays, 'decline')).toBeNull();
      expect(scheduledTransition(payment(status), farFuture, delays, 'timeout')).toBeNull();
      expect(scheduledTransition(payment(status), farFuture, delays, 'succeed')).toBeNull();
    });
  });

  describe('scheduledTransition — an unpersisted scenario is default success (§11.1)', () => {
    it.each([undefined, null])('%s behaves like `succeed`', (scenario) => {
      expect(
        scheduledTransition(
          payment('processing'),
          settled(),
          delays,
          scenario ?? undefined,
        ),
      ).toEqual({ from: 'processing', to: 'succeeded', event: 'payment.succeeded' });
    });

    it('an unknown value normalized by the parser never fails a payment', () => {
      const intent = parseSimulationScenario('not-a-scenario');
      expect(intent).toEqual(DEFAULT_SIMULATION_INTENT);
      expect(scheduledTransition(payment('processing'), settled(), delays, intent.scenario)).toEqual({
        from: 'processing',
        to: 'succeeded',
        event: 'payment.succeeded',
      });
    });
  });

  describe('injectable delays keep fast and exotic schedules deterministic', () => {
    it('zero delays advance immediately', () => {
      const zero = { pendingDelayMs: 0, settlementDelayMs: 0 };
      expect(scheduledTransition(payment('pending'), CREATED, zero)).toEqual({
        from: 'pending',
        to: 'processing',
        event: null,
      });
      expect(scheduledTransition(payment('processing'), CREATED, zero)).toEqual({
        from: 'processing',
        to: 'succeeded',
        event: 'payment.succeeded',
      });
      expect(scheduledTransition(payment('processing'), CREATED, zero, 'decline')).toEqual({
        from: 'processing',
        to: 'failed',
        event: 'payment.failed',
      });
      expect(scheduledTransition(payment('processing'), CREATED, zero, 'timeout')).toBeNull();
    });

    it('a never-elapsed clock does not advance a pending payment', () => {
      expect(
        scheduledTransition(payment('pending', new Date('2026-09-26T00:00:00.000Z')), CREATED, delays),
      ).toBeNull();
    });
  });
});
