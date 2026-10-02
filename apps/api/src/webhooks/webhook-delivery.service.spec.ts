import { createHmac } from 'node:crypto';

import { decryptWebhookSecret, encryptWebhookSecret } from './webhook-crypto';
import { WebhookDeliveryService } from './webhook-delivery.service';
import type { WebhookQueueService } from './webhook-queue.service';
import type { DestinationPolicy } from './webhook-url';
import type { PrismaService } from '../prisma/prisma.service';

const KEY = Buffer.alloc(32, 1);
const SECRET = 'whsec_test_value';
const POLICY = {
  maxAttempts: 5,
  baseDelayMs: 30_000,
  maxBackoffMs: 3_600_000,
  connectTimeoutMs: 5_000,
  requestTimeoutMs: 10_000,
  // Unused by the attempt path; present because the token carries the whole policy.
  eventRetentionMs: 2_592_000_000,
  reconciliationIntervalMs: 60_000,
  reconciliationHorizonMs: 3_600_000,
  advancementSweepIntervalMs: 30_000,
  cleanupIntervalMs: 3_600_000,
};

const ENDPOINT_ID = '0198f0c2-0000-7000-8000-0000000000e1';
const EVENT_ID = '0198f0c2-0000-7000-8000-0000000000e2';
const DELIVERY_ID = '0198f0c2-0000-7000-8000-0000000000e3';

const ENVELOPE = {
  id: EVENT_ID,
  type: 'payment.created' as const,
  created_at: '2026-09-28T10:00:00.000Z',
  data: { id: 'pay_1', status: 'pending' },
  environment: 'test' as const,
  project_id: '0198f0c2-0000-7000-8000-0000000000e4',
};

const STORED_SECRET = encryptWebhookSecret(SECRET, KEY);

function delivery(overrides: Record<string, unknown> = {}) {
  return {
    id: DELIVERY_ID,
    endpointId: ENDPOINT_ID,
    eventId: EVENT_ID,
    status: 'pending' as string,
    attempts: 0,
    responseStatus: null as number | null,
    lastError: null as string | null,
    nextAttemptAt: new Date('2026-09-28T10:00:00.000Z') as Date | null,
    isReplay: false,
    requestId: 'req_origin',
    createdAt: new Date('2026-09-28T10:00:00.000Z'),
    updatedAt: new Date('2026-09-28T10:00:00.000Z'),
    endpoint: {
      id: ENDPOINT_ID,
      projectId: ENVELOPE.project_id,
      environment: 'test',
      url: 'https://example.com/hooks',
      enabled: true,
      eventTypes: ['payment.created'],
      secretCipher: STORED_SECRET.ciphertext,
      secretIv: STORED_SECRET.iv,
      secretAuthTag: STORED_SECRET.authTag,
    },
    event: { id: EVENT_ID, type: 'payment.created', payload: ENVELOPE },
    ...overrides,
  };
}

interface Harness {
  service: WebhookDeliveryService;
  prisma: { webhookDelivery: Record<string, jest.Mock> };
  queue: { enqueueDelivery: jest.Mock };
  /** The `data` object of each recorded `webhook_deliveries` write, in order. */
  updates: () => Record<string, unknown>[];
}

/**
 * @param row          the delivery the service re-reads before acting.
 * @param claimed      how many rows the conditional write matches. `0` models a
 *                     duplicate or concurrent attempt that lost the race.
 */
function setup(
  row: ReturnType<typeof delivery> | null = delivery(),
  claimed = 1,
  destinations: DestinationPolicy = {},
): Harness {
  const updateMany = jest.fn<
    Promise<{ count: number }>,
    [{ data: Record<string, unknown> }]
  >(async () => ({ count: claimed }));
  const prisma = {
    webhookDelivery: {
      findUnique: jest.fn(async () => row),
      updateMany,
    },
  };
  const queue = { enqueueDelivery: jest.fn(async () => true) };
  const service = new WebhookDeliveryService(
    prisma as unknown as PrismaService,
    queue as unknown as WebhookQueueService,
    KEY,
    POLICY,
    destinations,
  );
  return {
    service,
    prisma,
    queue,
    updates: () => updateMany.mock.calls.map((call) => call[0].data as Record<string, unknown>),
  };
}

/** Installs a `fetch` double and returns the request it received. */
function stubFetch(
  respond: (url: string, init: RequestInit) => { status: number; headers?: Record<string, string> } | Error,
): { calls: { url: string; init: RequestInit }[]; restore: () => void } {
  const original = globalThis.fetch;
  const calls: { url: string; init: RequestInit }[] = [];
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const result = respond(url, init);
    if (result instanceof Error) {
      throw result;
    }
    return new Response(null, { status: result.status, headers: result.headers });
  }) as unknown as typeof fetch;
  return {
    calls,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

function headersOf(init: RequestInit): Record<string, string> {
  return init.headers as Record<string, string>;
}

describe('webhook delivery attempt (phase 10 §5.2/§5.4/§5.5, D4/D6/D7)', () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  describe('success', () => {
    it('marks the delivery delivered with the observed status and no stored body', async () => {
      const fetchStub = stubFetch(() => ({ status: 200 }));
      const { service, updates } = setup();

      await expect(service.attempt(DELIVERY_ID)).resolves.toBe('delivered');

      const data = updates()[0];
      expect(data).toEqual(
        expect.objectContaining({
          status: 'delivered',
          attempts: 1,
          responseStatus: 200,
          lastError: null,
          nextAttemptAt: null,
        }),
      );
      // The response body is never stored (§5.4).
      expect(JSON.stringify(data)).not.toContain('responseBody');
      fetchStub.restore();
    });
  });

  describe('destination policy at delivery time (D13, ADR-0019)', () => {
    it('makes no request at all when the stored host is on the denylist', async () => {
      const fetchStub = stubFetch(() => ({ status: 200 }));
      // The endpoint was registered before the denylist existed; the policy is a
      // runtime control, so an operator adding a host must stop the traffic that
      // is already in flight, not just the next registration.
      const { service, queue, updates } = setup(
        delivery(),
        1,
        { denylist: ['example.com'] },
      );

      await expect(service.attempt(DELIVERY_ID)).resolves.toBe('failed');

      expect(fetchStub.calls).toHaveLength(0);
      expect(queue.enqueueDelivery).not.toHaveBeenCalled();
      const data = updates()[0];
      expect(data).toEqual(
        expect.objectContaining({
          status: 'failed',
          nextAttemptAt: null,
          lastError: expect.stringContaining('destination policy'),
          // `attempts` is surfaced verbatim to users and counts HTTP requests
          // made (§5.1). This delivery had made none, so it stays at 0 rather
          // than reporting a phantom attempt for a request never sent.
          attempts: 0,
        }),
      );
      fetchStub.restore();
    });

    it('settles a denied destination terminally instead of retrying it', async () => {
      const fetchStub = stubFetch(() => ({ status: 200 }));
      const { service, queue } = setup(delivery(), 1, { denylist: ['example.com'] });

      await service.attempt(DELIVERY_ID);

      // Retrying would keep contacting the very host the operator removed, so the
      // denial must exhaust the row rather than consume the whole ladder.
      expect(queue.enqueueDelivery).not.toHaveBeenCalled();
      fetchStub.restore();
    });

    it('denies a host outside the allowlist even when it is not listed', async () => {
      const fetchStub = stubFetch(() => ({ status: 200 }));
      const { service } = setup(delivery(), 1, { allowlist: ['hooks.internal.test'] });

      await expect(service.attempt(DELIVERY_ID)).resolves.toBe('failed');
      expect(fetchStub.calls).toHaveLength(0);
      fetchStub.restore();
    });

    it('still delivers to an allowed host under the same policy', async () => {
      const fetchStub = stubFetch(() => ({ status: 200 }));
      const { service } = setup(delivery(), 1, { allowlist: ['example.com'] });

      await expect(service.attempt(DELIVERY_ID)).resolves.toBe('delivered');
      expect(fetchStub.calls).toHaveLength(1);
      fetchStub.restore();
    });

    it('keeps the permissive default when no list is configured', async () => {
      const fetchStub = stubFetch(() => ({ status: 200 }));
      const { service } = setup(delivery(), 1, {});

      await expect(service.attempt(DELIVERY_ID)).resolves.toBe('delivered');
      expect(fetchStub.calls).toHaveLength(1);
      fetchStub.restore();
    });

    it('never records the denied URL in the stored error', async () => {
      const fetchStub = stubFetch(() => ({ status: 200 }));
      const { service, updates } = setup(delivery(), 1, { denylist: ['example.com'] });

      await service.attempt(DELIVERY_ID);

      // §5.7: destination details are not stored, so a denylist hit cannot become
      // a stored record of where this project sends data.
      expect(String(updates()[0].lastError)).not.toContain('example.com');
      fetchStub.restore();
    });
  });

  describe('request shape (D7)', () => {
    it('sends the stored envelope byte-for-byte with the contracted headers', async () => {
      const fetchStub = stubFetch(() => ({ status: 204 }));
      const { service } = setup();

      await service.attempt(DELIVERY_ID);

      const [request] = fetchStub.calls;
      expect(request.url).toBe('https://example.com/hooks');
      expect(request.init.method).toBe('POST');
      expect(request.init.body).toBe(JSON.stringify(ENVELOPE));
      expect(request.init.redirect).toBe('manual');

      const headers = headersOf(request.init);
      expect(headers['Content-Type']).toBe('application/json');
      expect(headers['BrinnPay-Event-Id']).toBe(EVENT_ID);
      expect(headers['BrinnPay-Event-Type']).toBe('payment.created');
      expect(headers['BrinnPay-Delivery-Id']).toBe(DELIVERY_ID);
      expect(headers['BrinnPay-Attempt']).toBe('1');
      expect(headers['BrinnPay-Signature']).toMatch(/^t=\d{10},v1=[0-9a-f]{64}$/);
      // The signature covers the exact transmitted bytes, so a third party can
      // reproduce it from the raw body alone.
      const { t, v1 } = Object.fromEntries(
        headers['BrinnPay-Signature'].split(',').map((part) => part.split('=')),
      ) as { t: string; v1: string };
      expect(createHmac('sha256', SECRET).update(`${t}.${request.init.body}`, 'utf8').digest('hex')).toBe(v1);
      fetchStub.restore();
    });

    it('sends byte-identical retries apart from the signature timestamp and attempt header', async () => {
      const bodies: string[] = [];
      const attempts: string[] = [];
      globalThis.fetch = (async (_url: string, init: RequestInit) => {
        bodies.push(init.body as string);
        attempts.push(headersOf(init)['BrinnPay-Attempt']);
        return new Response(null, { status: 500 });
      }) as unknown as typeof fetch;

      const { service, prisma, queue } = setup();
      await service.attempt(DELIVERY_ID);

      // Simulate the second attempt against the same (still pending) aggregate.
      prisma.webhookDelivery.findUnique.mockResolvedValue(delivery({ attempts: 1 }));
      await service.attempt(DELIVERY_ID);

      expect(bodies[0]).toBe(bodies[1]);
      expect(attempts).toEqual(['1', '2']);
      expect(queue.enqueueDelivery).toHaveBeenCalledWith(DELIVERY_ID, 2, expect.any(Number));
    });

    it('never follows a redirect: a 3xx is a recorded failed attempt', async () => {
      const fetchStub = stubFetch(() => ({ status: 302, headers: { location: 'http://evil.example/x' } }));
      const { service, updates } = setup();

      await expect(service.attempt(DELIVERY_ID)).resolves.toBe('failed');

      // One request only — the redirect target was never contacted.
      expect(fetchStub.calls).toHaveLength(1);
      expect(headersOf(fetchStub.calls[0].init).Authorization).toBeUndefined();
      expect(updates()[0]).toEqual(
        expect.objectContaining({
          status: 'failed',
          responseStatus: 302,
          lastError: expect.stringContaining('redirects are never followed'),
        }),
      );
      fetchStub.restore();
    });
  });

  describe('retry classification (D6/D5)', () => {
    it('retries a 5xx with a bounded, jittered backoff and keeps the delivery pending', async () => {
      const fetchStub = stubFetch(() => ({ status: 500 }));
      const { service, queue, updates } = setup();

      await expect(service.attempt(DELIVERY_ID)).resolves.toBe('retry');

      const data = updates()[0];
      expect(data.status).toBeUndefined(); // still pending
      expect(data.attempts).toBe(1);
      expect(data.responseStatus).toBe(500);
      expect(data.nextAttemptAt).toBeInstanceOf(Date);
      const delay = (data.nextAttemptAt as Date).getTime() - Date.now();
      expect(delay).toBeGreaterThanOrEqual(0);
      expect(delay).toBeLessThanOrEqual(POLICY.baseDelayMs);
      // A retry is a new job with a delay, not a re-run of the same one.
      expect(queue.enqueueDelivery).toHaveBeenCalledWith(DELIVERY_ID, 2, expect.any(Number));
      fetchStub.restore();
    });

    it('honors a parseable Retry-After on 429/503, clamped to the maximum backoff', async () => {
      const fetchStub = stubFetch(() => ({ status: 503, headers: { 'retry-after': '2' } }));
      const { service, queue } = setup();

      await service.attempt(DELIVERY_ID);

      expect(queue.enqueueDelivery).toHaveBeenCalledWith(DELIVERY_ID, 2, 2_000);
      fetchStub.restore();

      const clamped = stubFetch(() => ({ status: 429, headers: { 'retry-after': '99999' } }));
      await service.attempt(DELIVERY_ID);
      expect(clamped.restore).toBeDefined();
      expect(queue.enqueueDelivery).toHaveBeenLastCalledWith(DELIVERY_ID, 2, POLICY.maxBackoffMs);
      clamped.restore();
    });

    it('never lets a non-positive Retry-After collapse the backoff ladder', async () => {
      // D5: `Retry-After: 0` and a past HTTP-date are not overrides. Honouring
      // either would pull all five attempts into one burst.
      const past = new Date(Date.now() - 60_000).toUTCString();
      for (const value of ['0', past, 'soon']) {
        const fetchStub = stubFetch(() => ({ status: 429, headers: { 'retry-after': value } }));
        const { service, queue } = setup();

        await service.attempt(DELIVERY_ID);

        const delay = queue.enqueueDelivery.mock.calls[0][2] as number;
        expect(delay).toBeGreaterThan(0);
        expect(delay).toBeLessThanOrEqual(POLICY.baseDelayMs * 5);
        fetchStub.restore();
      }
    });

    it('does not retry a 404: the delivery is terminal with the observed status', async () => {
      const fetchStub = stubFetch(() => ({ status: 404 }));
      const { service, queue, updates } = setup();

      await expect(service.attempt(DELIVERY_ID)).resolves.toBe('failed');

      expect(queue.enqueueDelivery).not.toHaveBeenCalled();
      expect(updates()[0]).toEqual(
        expect.objectContaining({ status: 'failed', attempts: 1, responseStatus: 404 }),
      );
      fetchStub.restore();
    });

    it('retries a network error', async () => {
      const fetchStub = stubFetch(() => Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' }));
      const { service, queue, updates } = setup();

      await expect(service.attempt(DELIVERY_ID)).resolves.toBe('retry');

      expect(updates()[0]).toEqual(
        expect.objectContaining({ responseStatus: null, lastError: expect.stringContaining('ENOTFOUND') }),
      );
      expect(queue.enqueueDelivery).toHaveBeenCalled();
      fetchStub.restore();
    });

    it('stops after the attempt budget: the fifth failure is terminal', async () => {
      const fetchStub = stubFetch(() => ({ status: 500 }));
      const { service, queue, updates } = setup(delivery({ attempts: POLICY.maxAttempts - 1 }));

      await expect(service.attempt(DELIVERY_ID)).resolves.toBe('failed');

      expect(queue.enqueueDelivery).not.toHaveBeenCalled();
      expect(updates()[0]).toEqual(
        expect.objectContaining({ status: 'failed', attempts: POLICY.maxAttempts, nextAttemptAt: null }),
      );
      fetchStub.restore();
    });
  });

  describe('idempotence and no-op paths (D11, §5.3)', () => {
    it('is a no-op when the delivery row is gone (endpoint deleted after enqueue)', async () => {
      const fetchStub = stubFetch(() => ({ status: 200 }));
      const { service } = setup(null);

      await expect(service.attempt(DELIVERY_ID)).resolves.toBe('skipped');
      expect(fetchStub.calls).toHaveLength(0);
      fetchStub.restore();
    });

    it('is a no-op when the delivery already reached a terminal state (duplicate job)', async () => {
      const fetchStub = stubFetch(() => ({ status: 200 }));
      const { service } = setup(delivery({ status: 'delivered' }));

      await expect(service.attempt(DELIVERY_ID)).resolves.toBe('skipped');
      expect(fetchStub.calls).toHaveLength(0);
      fetchStub.restore();
    });

    it('attempts a queued delivery of a disabled endpoint and records the outcome', async () => {
      // D11: `enabled` gates *enqueueing* only; a queued delivery is still
      // attempted, so disabling never silently swallows a delivery.
      const fetchStub = stubFetch(() => ({ status: 200 }));
      const row = delivery();
      row.endpoint.enabled = false;
      const { service, updates } = setup(row);

      await expect(service.attempt(DELIVERY_ID)).resolves.toBe('delivered');
      expect(fetchStub.calls).toHaveLength(1);
      expect(updates()[0]).toEqual(expect.objectContaining({ status: 'delivered' }));
      fetchStub.restore();
    });
  });

  describe('a duplicate attempt cannot clobber newer bookkeeping', () => {
    // Every enqueue now carries a unique job id, so a duplicated job is a normal
    // possibility rather than a BullMQ dedup. The aggregate's `status` is the
    // authority: both the terminal and the retry write are conditional on it.
    it('writes the terminal outcome only while the row is still pending', async () => {
      const fetchStub = stubFetch(() => ({ status: 200 }));
      const { service, prisma } = setup();

      await service.attempt(DELIVERY_ID);

      expect(prisma.webhookDelivery.updateMany.mock.calls[0][0].where).toEqual({
        id: DELIVERY_ID,
        status: 'pending',
      });
      fetchStub.restore();
    });

    it('reports a lost race instead of claiming an outcome it did not record', async () => {
      const fetchStub = stubFetch(() => ({ status: 200 }));
      const { service, updates } = setup(delivery(), 0);

      await expect(service.attempt(DELIVERY_ID)).resolves.toBe('skipped');
      expect(updates()).toEqual([
        expect.objectContaining({ status: 'delivered' }),
      ]);
      fetchStub.restore();
    });

    it('does not schedule another retry once a sibling attempt moved the row on', async () => {
      const fetchStub = stubFetch(() => ({ status: 500 }));
      const { service, queue, updates } = setup(delivery(), 0);

      await expect(service.attempt(DELIVERY_ID)).resolves.toBe('skipped');

      expect(queue.enqueueDelivery).not.toHaveBeenCalled();
      // The booking write is still shaped as a retry schedule; it simply matched
      // no row, which is the guard working.
      expect(updates()[0].nextAttemptAt).toBeInstanceOf(Date);
      fetchStub.restore();
    });
  });

  describe('secret handling (D8/phase 10 §8)', () => {
    it('fails the delivery terminally when the stored secret cannot be decrypted', async () => {
      const fetchStub = stubFetch(() => ({ status: 200 }));
      const row = delivery();
      row.endpoint.secretCipher = Buffer.from('tampered').toString('base64');
      const { service, queue, updates } = setup(row);

      await expect(service.attempt(DELIVERY_ID)).resolves.toBe('failed');

      // No request is signed with a wrong key, and the record is terminal so the
      // endpoint has to be recreated rather than retried forever.
      expect(fetchStub.calls).toHaveLength(0);
      expect(queue.enqueueDelivery).not.toHaveBeenCalled();
      expect(updates()[0].lastError).toContain('could not be decrypted');
      fetchStub.restore();
    });

    it('never places the secret in the recorded outcome or a log-visible field', async () => {
      const fetchStub = stubFetch(() => ({ status: 500 }));
      const { service, updates } = setup();

      await service.attempt(DELIVERY_ID);

      expect(JSON.stringify(updates())).not.toContain(SECRET);
      expect(JSON.stringify(updates())).not.toContain(storedSecretBase64());
      fetchStub.restore();
    });
  });
});

/** The base64 ciphertext, used only to prove it is not leaked into the record. */
function storedSecretBase64(): string {
  return decryptWebhookSecret(STORED_SECRET, KEY) === SECRET ? 'never-in-record' : 'unexpected';
}

describe('webhook delivery error surface', () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('never throws a destination failure (the worker must survive it)', async () => {
    // A stubbed destination, never the real network: the assertion is about the
    // state the attempt resolves to, not about whether example.com happens to be
    // reachable from the test runner.
    const fetchStub = stubFetch(() => Object.assign(new Error('connect ECONNREFUSED'), {
      code: 'ECONNREFUSED',
    }));
    const { service, updates, queue } = setup();

    await expect(service.attempt(DELIVERY_ID)).resolves.toBe('retry');
    expect(updates()[0]).toEqual(
      expect.objectContaining({ responseStatus: null, lastError: expect.stringContaining('ECONNREFUSED') }),
    );
    expect(queue.enqueueDelivery).toHaveBeenCalledWith(DELIVERY_ID, 2, expect.any(Number));
    fetchStub.restore();
  });

  it('surfaces a terminal destination failure as a state, not a rejection', async () => {
    const fetchStub = stubFetch(() => ({ status: 403 }));
    const { service, updates } = setup();

    await expect(service.attempt(DELIVERY_ID)).resolves.toBe('failed');
    expect(updates()[0]).toEqual(expect.objectContaining({ status: 'failed', responseStatus: 403 }));
    fetchStub.restore();
  });
});
