import {
  DEFAULT_SIMULATION_DELAYS,
  scheduledTransition,
  type SimulationOutcome,
} from './payment-simulation';
import type { PaymentStatus } from './payment-types';

const CREATED = new Date('2026-09-25T00:00:00.000Z');

function payment(status: PaymentStatus, createdAt: Date = CREATED) {
  return { status, createdAt };
}

describe('payment simulation (phase 7 §4.6, D2)', () => {
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

    it('processing → succeeded (default outcome) at the settlement time', () => {
      expect(
        scheduledTransition(
          payment('processing'),
          new Date(CREATED.getTime() + delays.pendingDelayMs + delays.settlementDelayMs),
          delays,
        ),
      ).toEqual({ from: 'processing', to: 'succeeded', event: 'payment.succeeded' });
    });

    it('processing → failed carries the payment.failed event (service-level edge, D2)', () => {
      expect(
        scheduledTransition(
          payment('processing'),
          new Date(CREATED.getTime() + delays.pendingDelayMs + delays.settlementDelayMs),
          delays,
          'failed' satisfies SimulationOutcome,
        ),
      ).toEqual({ from: 'processing', to: 'failed', event: 'payment.failed' });
    });

    it('pending → processing is NOT outcome-dependent (failure only ever fires at settlement)', () => {
      expect(
        scheduledTransition(
          payment('pending'),
          new Date(CREATED.getTime() + delays.pendingDelayMs),
          delays,
          'failed',
        ),
      ).toEqual({ from: 'pending', to: 'processing', event: null });
    });
  });

  describe('scheduledTransition — terminal states are absorbing', () => {
    it.each(['succeeded', 'failed'] as const)('%s never transitions', (status) => {
      const farFuture = new Date(CREATED.getTime() + 60_000);
      expect(scheduledTransition(payment(status), farFuture, delays)).toBeNull();
      expect(scheduledTransition(payment(status), farFuture, delays, 'failed')).toBeNull();
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
    });

    it('a never-elapsed clock does not advance a pending payment', () => {
      expect(
        scheduledTransition(payment('pending', new Date('2026-09-26T00:00:00.000Z')), CREATED, delays),
      ).toBeNull();
    });
  });
});