import type { ConfigService } from '@nestjs/config';

import { deliverJobId, WEBHOOK_JOBS } from './webhook-queue';
import { provideDeliveryPolicy, provideJobRetention } from './webhook-queue.service';

/**
 * The shipped defaults, keyed the way `configuration.ts` nests them: the
 * providers read `webhooks.*`, not the `WEBHOOK_*` environment names. Serving
 * the environment names here made every override a silent no-op — the provider
 * missed the key, fell back to the code default, and the test asserted nothing.
 */
const POLICY: Record<string, number> = {
  'webhooks.maxAttempts': 5,
  'webhooks.baseBackoffMs': 30_000,
  'webhooks.maxBackoffMs': 3_600_000,
  'webhooks.connectTimeoutMs': 5_000,
  'webhooks.requestTimeoutMs': 10_000,
  'webhooks.eventRetentionDays': 30,
  'webhooks.reconciliationIntervalMs': 60_000,
  'webhooks.reconciliationHorizonMs': 3_600_000,
  'webhooks.advancementSweepIntervalMs': 5_000,
  'webhooks.cleanupIntervalMs': 3_600_000,
  'webhooks.failedJobRetentionMs': 604_800_000,
  'webhooks.retainedFailedJobs': 1_000,
};

/** Unknown keys throw instead of returning `undefined`, so a namespace change in
 * `configuration.ts` fails a test rather than silently restoring a default. */
function config(overrides: Record<string, number> = {}): ConfigService {
  const values = { ...POLICY, ...overrides };
  return {
    get: (key: string): number => {
      if (!(key in values)) {
        throw new Error(`Test configuration does not define "${key}".`);
      }
      return values[key] as number;
    },
  } as unknown as ConfigService;
}

describe('delivery job ids', () => {
  it('keeps the delivery id and attempt readable while staying unique per enqueue', () => {
    // D11: a retry is a *new* job, so a deterministic id would collide with the
    // key BullMQ keeps for a job that ended in the `failed` set. The re-add would
    // be dropped silently while the caller believed the retry was scheduled,
    // stranding the delivery in `pending` with a full attempt budget left.
    const first = deliverJobId('dlv_1', 2);
    const second = deliverJobId('dlv_1', 2);

    expect(first).not.toBe(second);
    expect(first.startsWith(`${WEBHOOK_JOBS.DELIVER}-dlv_1-2-`)).toBe(true);
    // BullMQ keys are `prefix:queue:jobId`, so a custom id may not contain `:`
    // or every add is rejected and the delivery is never scheduled.
    expect(first).not.toContain(':');
  });

  it('never reuses an id across attempts of the same delivery', () => {
    const ids = [1, 2, 3, 4, 5].map((attempt) => deliverJobId('dlv_1', attempt));

    expect(new Set(ids).size).toBe(5);
  });
});

describe('job retention (D11, ADR-0018)', () => {
  it('removes completed jobs at once and bounds the failed set by age and count', () => {
    // Completed jobs carry no information that is not already in the delivery row,
    // so keeping them is pure Redis growth. Failed jobs are the ones worth
    // inspecting, and they are what an unremoved `failed` set accumulates forever.
    expect(provideJobRetention(config())).toEqual({
      removeOnComplete: true,
      removeOnFail: { age: 604_800_000, count: 1_000 },
    });
  });

  it('honours the configured retention', () => {
    const retention = provideJobRetention(
      config({ 'webhooks.failedJobRetentionMs': 3_600_000, 'webhooks.retainedFailedJobs': 5 }),
    );

    expect(retention.removeOnFail).toEqual({ age: 3_600_000, count: 5 });
  });
});

describe('delivery policy', () => {
  it('carries the reconciliation horizon from configuration', () => {
    expect(provideDeliveryPolicy(config()).reconciliationHorizonMs).toBe(3_600_000);
    expect(provideDeliveryPolicy(config({ 'webhooks.reconciliationHorizonMs': 60_000 }))
      .reconciliationHorizonMs).toBe(60_000);
  });

  it('rejects a horizon that is not longer than the pass\'s minimum age', () => {
    // A horizon at or below the minimum age leaves an empty window, so the safety
    // net would silently stop repairing anything — a misconfiguration must fail
    // at boot, not degrade in production.
    expect(() => provideDeliveryPolicy(config({ 'webhooks.reconciliationHorizonMs': 30_000 })))
      .toThrow(/WEBHOOK_RECONCILIATION_HORIZON_MS/);
  });

  it('converts the retention window from days to milliseconds', () => {
    // The environment variable is in days (`WEBHOOK_EVENT_RETENTION_DAYS`) while
    // the cleanup job works in milliseconds; reading one as the other silently
    // prunes events hours or centuries from now.
    expect(provideDeliveryPolicy(config()).eventRetentionMs).toBe(2_592_000_000);
    expect(provideDeliveryPolicy(config({ 'webhooks.eventRetentionDays': 1 })).eventRetentionMs)
      .toBe(86_400_000);
  });
});
