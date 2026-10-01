import { RequestMethod } from '@nestjs/common';

import { ApiError } from '../common/errors/api-error';
import type { ProjectScope } from '../common/project-scope/project-scope';
import { decryptWebhookSecret, encryptWebhookSecret, WEBHOOK_SECRET_KEY } from './webhook-crypto';
import { WebhooksService } from './webhooks.service';
import { WebhookQueueService } from './webhook-queue.service';
import { WEBHOOK_DESTINATIONS, type DestinationPolicy } from './webhook-url';
import type { PrismaService } from '../prisma/prisma.service';
import { WebhooksController } from './webhooks.controller';

const KEY = Buffer.alloc(32, 7);
const PROJECT = '0198f0c2-0000-7000-8000-000000000011';
const OTHER_PROJECT = '0198f0c2-0000-7000-8000-000000000022';
const ENDPOINT_ID = '0198f0c2-0000-7000-8000-0000000000e1';
const EVENT_ID = '0198f0c2-0000-7000-8000-0000000000e2';

const SESSION: ProjectScope = {
  mode: 'session',
  project: { project_id: PROJECT, environment: 'test', role: 'owner' } as never,
  project_id: PROJECT,
};

const API_KEY: ProjectScope = {
  mode: 'api_key',
  key: { project_id: PROJECT, environment: 'test' } as never,
  project_id: PROJECT,
  environment: 'test',
};

function endpointRow(overrides: Record<string, unknown> = {}) {
  return {
    id: ENDPOINT_ID,
    projectId: PROJECT,
    environment: 'test',
    url: 'https://example.com/hooks',
    eventTypes: ['payment.created', 'refund.created'],
    enabled: true,
    secretCipher: '',
    secretIv: '',
    secretAuthTag: '',
    createdAt: new Date('2026-09-28T10:00:00.000Z'),
    updatedAt: new Date('2026-09-28T10:00:00.000Z'),
    ...overrides,
  };
}

type MockModel = Record<string, jest.Mock>;

function eventRow(overrides: Record<string, unknown> = {}) {
  return {
    id: EVENT_ID,
    projectId: PROJECT,
    environment: 'test',
    type: 'payment.created',
    createdAt: new Date('2026-09-28T10:00:00.000Z'),
    ...overrides,
  };
}

function setup(destinations: DestinationPolicy = {}) {
  const prisma: Record<string, MockModel> = {
    webhookEndpoint: {
      findMany: jest.fn(),
      findFirst: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
    },
    webhookEvent: { findMany: jest.fn(), findFirst: jest.fn() },
    webhookDelivery: { findMany: jest.fn(), create: jest.fn() },
  };
  // Defaults: an endpoint and an event both exist in the addressed scope.
  prisma.webhookEndpoint.findMany.mockResolvedValue([endpointRow()]);
  prisma.webhookEndpoint.findFirst.mockResolvedValue(endpointRow());
  prisma.webhookEndpoint.create.mockImplementation(
    async ({ data }: { data: Record<string, unknown> }) => endpointRow(data),
  );
  prisma.webhookEndpoint.update.mockImplementation(
    async ({ data }: { data: Record<string, unknown> }) => endpointRow(data),
  );
  prisma.webhookEndpoint.delete.mockResolvedValue({});
  prisma.webhookEvent.findMany.mockResolvedValue([]);
  prisma.webhookEvent.findFirst.mockResolvedValue(eventRow());
  prisma.webhookDelivery.findMany.mockResolvedValue([]);
  prisma.webhookDelivery.create.mockImplementation(
    async ({ data }: { data: Record<string, unknown> }) => data,
  );

  const queue = { enqueueDelivery: jest.fn().mockResolvedValue(true) };
  const service = new WebhooksService(
    prisma as unknown as PrismaService,
    queue as unknown as WebhookQueueService,
    KEY,
    destinations,
  );
  return { service, prisma, queue };
}

/**
 * The observable rejection of a call: the envelope's code/status plus every
 * `details.fields` message, which is where a 400 names the offending field.
 */
async function caught(run: () => Promise<unknown>): Promise<{
  code: string;
  status: number;
  message: string;
  fields: string[];
}> {
  try {
    await run();
  } catch (error) {
    if (!(error instanceof ApiError)) {
      throw error;
    }
    const details = error.details as { fields?: { errors: string[] }[] } | undefined;
    return {
      code: error.code,
      status: error.getStatus(),
      message: error.message,
      fields: (details?.fields ?? []).flatMap((entry) => entry.errors),
    };
  }
  throw new Error('expected a rejection');
}

describe('webhook endpoint registry (phase 10 §4.4/§4.6, D1/D8/D10/D16)', () => {
  describe('create (201)', () => {
    it('generates a CSPRNG secret, stores it encrypted, and returns it exactly once', async () => {
      const { service, prisma } = setup();

      const created = await service.createEndpoint(SESSION, {
        url: 'https://example.com/hooks',
        event_types: ['payment.created'],
        environment: 'test',
      });

      const stored = prisma.webhookEndpoint.create.mock.calls[0][0].data;
      // 32 bytes of entropy, base64url-encoded (D8), stored as base64 AES-256-GCM
      // ciphertext and never in plaintext.
      expect(created.signing_secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(stored.secretCipher).toEqual(expect.any(String));
      expect(stored.secretCipher).not.toBe(created.signing_secret);
      expect(stored.secretIv).toEqual(expect.any(String));
      expect(stored.secretAuthTag).toEqual(expect.any(String));
      expect(decryptWebhookSecret(
        { ciphertext: stored.secretCipher, iv: stored.secretIv, authTag: stored.secretAuthTag },
        KEY,
      )).toBe(created.signing_secret);
      // A fresh secret per endpoint.
      const second = await service.createEndpoint(SESSION, {
        url: 'https://example.com/hooks',
        event_types: ['payment.created'],
        environment: 'test',
      });
      expect(second.signing_secret).not.toBe(created.signing_secret);
    });

    it('never returns the secret again on read, list, or patch', async () => {
      const { service, prisma } = setup();
      seedStoredSecret(prisma);

      const retrieved = await service.retrieveEndpoint(SESSION, ENDPOINT_ID);
      const [page] = (await service.listEndpoints(SESSION, { environment: 'test' })).data;
      const patched = await service.updateEndpoint(SESSION, ENDPOINT_ID, { enabled: false });

      for (const projection of [retrieved, page, patched]) {
        expect('signing_secret' in projection).toBe(false);
        expect(JSON.stringify(projection)).not.toContain('secret');
      }

      /** Seeds the row returned by the fake client with a real encrypted secret. */
      function seedStoredSecret(client: Record<string, MockModel>): void {
        const stored = encryptWebhookSecret('whsec_something', KEY);
        client.webhookEndpoint.findFirst.mockResolvedValue(
          endpointRow({
            secretCipher: stored.ciphertext,
            secretIv: stored.iv,
            secretAuthTag: stored.authTag,
          }),
        );
      }
    });

    it('defaults to enabled and accepts a duplicate URL (D16)', async () => {
      const { service, prisma } = setup();


      const first = await service.createEndpoint(SESSION, {
        url: 'https://example.com/hooks',
        event_types: ['payment.created'],
        environment: 'test',
      });
      const second = await service.createEndpoint(SESSION, {
        url: 'https://example.com/hooks',
        event_types: ['payment.succeeded'],
        environment: 'test',
      });

      expect(first.enabled).toBe(true);
      expect(second.id).not.toBe(first.id);
      // No uniqueness constraint is consulted: duplicates are a legitimate
      // pattern of splitting subscriptions across endpoints.
      expect(prisma.webhookEndpoint.create).toHaveBeenCalledTimes(2);
    });
  });

  describe('subscription validation (D1, §4.6)', () => {
    it('rejects an empty list', async () => {
      const { service } = setup();
      const error = await caught(() =>
        service.createEndpoint(SESSION, {
          url: 'https://example.com/hooks',
          event_types: [],
          environment: 'test',
        }),
      );
      expect(error.status).toBe(400);
      expect(error.fields.join(' ')).toContain('event_types');
    });

    it('rejects a duplicate entry', async () => {
      const { service } = setup();
      const error = await caught(() =>
        service.createEndpoint(SESSION, {
          url: 'https://example.com/hooks',
          event_types: ['payment.created', 'payment.created'],
          environment: 'test',
        }),
      );
      expect(error.status).toBe(400);
    });

    it('deduplicates nothing silently: an unknown type never reaches storage', async () => {
      const { service, prisma } = setup();
      await caught(() =>
        service.createEndpoint(SESSION, {
          url: 'https://example.com/hooks',
          event_types: ['payment.created', 'customer.created'] as never,
          environment: 'test',
        }),
      );
      expect(prisma.webhookEndpoint.create).not.toHaveBeenCalled();
    });
  });

  describe('update (patch)', () => {
    it('updates only the provided fields and never rotates the secret', async () => {
      const { service, prisma } = setup();

      await service.updateEndpoint(SESSION, ENDPOINT_ID, { event_types: ['refund.created'] });

      const data = prisma.webhookEndpoint.update.mock.calls[0][0].data;
      expect(data.eventTypes).toEqual(['refund.created']);
      expect(data.url).toBeUndefined();
      expect(data.enabled).toBeUndefined();
      // D8: no rotation in v1; recovery is delete and recreate.
      expect(Object.keys(data)).not.toContain('secretCipher');
    });

    it('rejects an empty patch as a caller mistake', async () => {
      const { service } = setup();
      const error = await caught(() => service.updateEndpoint(SESSION, ENDPOINT_ID, {}));
      expect(error.status).toBe(400);
    });
  });

  describe('delete (204)', () => {
    it('deletes the endpoint; its deliveries cascade and its events survive (D11)', async () => {
      const { service, prisma } = setup();

      await service.deleteEndpoint(SESSION, ENDPOINT_ID);

      expect(prisma.webhookEndpoint.delete).toHaveBeenCalledWith({ where: { id: ENDPOINT_ID } });
      // No business rule is invented at delete time, and the events are untouched.
      expect(prisma.webhookEvent.findMany).not.toHaveBeenCalled();
    });
  });

  describe('environment resolution (D1/F6, §4.5)', () => {
    it('requires an explicit environment for session list operations (400)', async () => {
      const { service, prisma } = setup();
      const error = await caught(() => service.listEndpoints(SESSION, {} as never));
      expect(error.status).toBe(400);
      expect(prisma.webhookEndpoint.findMany).not.toHaveBeenCalled();
    });

    it('derives the environment from an API key and rejects a conflicting explicit value (422)', async () => {
      const { service, prisma } = setup();

      await service.listEndpoints(API_KEY, {} as never);
      expect(prisma.webhookEndpoint.findMany.mock.calls[0][0].where.environment).toBe('test');

      const error = await caught(() => service.listEndpoints(API_KEY, { environment: 'live' } as never));
      expect(error.status).toBe(422);
    });

    it('scopes an endpoint lookup to the key environment, so the other environment is 404', async () => {
      const { service, prisma } = setup();
      prisma.webhookEndpoint.findFirst.mockResolvedValue(null);

      const error = await caught(() => service.retrieveEndpoint(API_KEY, ENDPOINT_ID));

      expect(error.status).toBe(404);
      expect(prisma.webhookEndpoint.findFirst.mock.calls[0][0].where).toEqual(
        expect.objectContaining({ projectId: PROJECT, environment: 'test' }),
      );
    });
  });

  describe('non-disclosure scoping (§8)', () => {
    it('treats a malformed, foreign, and unknown endpoint id identically', async () => {
      const { service, prisma } = setup();
      prisma.webhookEndpoint.findFirst.mockResolvedValue(null);

      const results = await Promise.all([
        caught(() => service.retrieveEndpoint(SESSION, 'not-a-uuid')),
        caught(() => service.retrieveEndpoint(SESSION, ENDPOINT_ID)),
        caught(() => service.retrieveEndpoint({ ...SESSION, project_id: OTHER_PROJECT } as ProjectScope, ENDPOINT_ID)),
      ]);

      expect(results[0]).toEqual(results[1]);
      expect(results[1]).toEqual(results[2]);
      expect(results[0].status).toBe(404);
    });

    it('never queries an endpoint by id alone', async () => {
      const { service, prisma } = setup();
      await service.retrieveEndpoint(SESSION, ENDPOINT_ID);
      expect(prisma.webhookEndpoint.findFirst.mock.calls[0][0].where.projectId).toBe(PROJECT);
    });
  });

  describe('replay (§5.6, D12)', () => {
    const endpoint = { environment: 'test', enabled: true, eventTypes: ['payment.created'] };

    it('creates a new replay delivery for the same event and never a new event', async () => {
      const { service, prisma, queue } = setup();
      prisma.webhookEndpoint.findFirst.mockResolvedValue(endpointRow({ ...endpoint }));

      await service.replayEvent(SESSION, ENDPOINT_ID, EVENT_ID, 'req_replay');

      expect(prisma.webhookEvent.findMany).not.toHaveBeenCalled();
      const data = prisma.webhookDelivery.create.mock.calls[0][0].data;
      expect(data).toEqual(
        expect.objectContaining({
          endpointId: ENDPOINT_ID,
          eventId: EVENT_ID,
          status: 'pending',
          attempts: 0,
          isReplay: true,
          requestId: 'req_replay',
        }),
      );
      expect(queue.enqueueDelivery).toHaveBeenCalledWith(data.id, 1, 0);
    });

    it('is not idempotency-key protected: repeated calls create repeated deliveries', async () => {
      const { service, prisma } = setup();
      prisma.webhookEndpoint.findFirst.mockResolvedValue(endpointRow({ ...endpoint }));

      await service.replayEvent(SESSION, ENDPOINT_ID, EVENT_ID);
      await service.replayEvent(SESSION, ENDPOINT_ID, EVENT_ID);

      expect(prisma.webhookDelivery.create).toHaveBeenCalledTimes(2);
      expect(prisma.webhookDelivery.create.mock.calls[0][0].data.id).not.toBe(
        prisma.webhookDelivery.create.mock.calls[1][0].data.id,
      );
    });

    it('scopes the event to the same project and the endpoint environment (404 otherwise)', async () => {
      const { service, prisma } = setup();
      prisma.webhookEndpoint.findFirst.mockResolvedValue(endpointRow({ ...endpoint }));
      prisma.webhookEvent.findFirst.mockResolvedValue(null);

      const error = await caught(() => service.replayEvent(SESSION, ENDPOINT_ID, EVENT_ID));

      expect(error.status).toBe(404);
      expect(prisma.webhookDelivery.create).not.toHaveBeenCalled();
      expect(prisma.webhookEvent.findFirst.mock.calls[0][0].where).toEqual(
        expect.objectContaining({ id: EVENT_ID, projectId: PROJECT, environment: 'test' }),
      );
    });

    it('rejects a disabled endpoint with a 422 that reveals nothing about its configuration', async () => {
      const { service, prisma } = setup();
      prisma.webhookEndpoint.findFirst.mockResolvedValue(endpointRow({ ...endpoint, enabled: false }));

      const error = await caught(() => service.replayEvent(SESSION, ENDPOINT_ID, EVENT_ID));

      expect(error.status).toBe(422);
      expect(prisma.webhookDelivery.create).not.toHaveBeenCalled();
    });

    it('rejects an endpoint that is no longer subscribed to the type with the same 422', async () => {
      const { service, prisma } = setup();
      prisma.webhookEndpoint.findFirst.mockResolvedValue(
        endpointRow({ ...endpoint, eventTypes: ['refund.created'] }),
      );

      const error = await caught(() => service.replayEvent(SESSION, ENDPOINT_ID, EVENT_ID));

      expect(error.status).toBe(422);
    });
  });

  describe('listings (D15)', () => {
    it('scopes events to the project/environment and applies the type filter', async () => {
      const { service, prisma } = setup();

      await service.listEvents(SESSION, { environment: 'test', type: 'payment.created' });

      expect(prisma.webhookEvent.findMany.mock.calls[0][0].where).toEqual(
        expect.objectContaining({ projectId: PROJECT, environment: 'test', type: 'payment.created' }),
      );
    });

    it('scopes deliveries to the addressed endpoint and applies the status filter', async () => {
      const { service, prisma } = setup();

      await service.listDeliveries(SESSION, ENDPOINT_ID, { status: 'failed' });

      expect(prisma.webhookDelivery.findMany.mock.calls[0][0].where).toEqual(
        expect.objectContaining({ endpointId: ENDPOINT_ID, status: 'failed' }),
      );
    });

    it('projects a delivery without a response body and with a nullable last_error', async () => {
      const { service, prisma } = setup();
      prisma.webhookDelivery.findMany.mockResolvedValue([
        {
          id: 'dlv_1',
          endpointId: ENDPOINT_ID,
          eventId: EVENT_ID,
          status: 'failed',
          attempts: 5,
          responseStatus: null,
          lastError: 'destination responded 500',
          nextAttemptAt: null,
          isReplay: false,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ]);

      const page = await service.listDeliveries(SESSION, ENDPOINT_ID, {} as never);

      expect(page.data[0]).toEqual(
        expect.objectContaining({
          id: 'dlv_1',
          status: 'failed',
          attempts: 5,
          response_status: null,
          last_error: 'destination responded 500',
          next_attempt_at: null,
          is_replay: false,
        }),
      );
    });
  });
});

describe('webhook controller metadata (phase 10 §4.4, D10)', () => {
  const HANDLERS = [
    'listEndpoints',
    'createEndpoint',
    'retrieveEndpoint',
    'updateEndpoint',
    'deleteEndpoint',
    'listDeliveries',
    'listEvents',
    'replayEvent',
  ] as const;

  const handlerOf = (name: (typeof HANDLERS)[number]) =>
    Object.getOwnPropertyDescriptor(WebhooksController.prototype, name)?.value as object;

  const routeOf = (name: (typeof HANDLERS)[number]) => ({
    // Nest stores the request method as a `RequestMethod` enum value.
    method: RequestMethod[Reflect.getMetadata('method', handlerOf(name)) as RequestMethod],
    path: Reflect.getMetadata('path', handlerOf(name)) as string,
  });

  const capabilityOf = (name: (typeof HANDLERS)[number]) =>
    (Reflect.getMetadata('brinnpay:capability', handlerOf(name)) as { capability?: string } | undefined)
      ?.capability;

  const guardsOf = (name: (typeof HANDLERS)[number]) =>
    ((Reflect.getMetadata('__guards__', handlerOf(name)) ?? []) as { name: string }[]).map(
      (guard) => guard.name,
    );

  it('is mounted under the project-nested prefix', () => {
    expect(Reflect.getMetadata('path', WebhooksController)).toBe('projects/:project_id');
  });

  it('exposes the eight contracted operations under the project-nested prefix', () => {
    expect(HANDLERS.map((name) => { const r = routeOf(name); return `${r.method} ${r.path}`; }).sort()).toEqual(
      [
        'GET webhook-endpoints',
        'GET webhook-endpoints/:endpoint_id',
        'GET webhook-endpoints/:endpoint_id/deliveries',
        'GET webhook-events',
        'PATCH webhook-endpoints/:endpoint_id',
        'POST webhook-endpoints',
        'POST webhook-endpoints/:endpoint_id/events/:event_id/replay',
        'DELETE webhook-endpoints/:endpoint_id',
      ].sort(),
    );
  });

  it('reads require webhooks.read and mutations require their own capability (D10)', () => {
    const byName = Object.fromEntries(HANDLERS.map((name) => [name, capabilityOf(name)]));
    expect(byName.listEndpoints).toBe('webhooks.read');
    expect(byName.retrieveEndpoint).toBe('webhooks.read');
    expect(byName.listDeliveries).toBe('webhooks.read');
    expect(byName.listEvents).toBe('webhooks.read');
    expect(byName.createEndpoint).toBe('webhooks.create');
    expect(byName.updateEndpoint).toBe('webhooks.update');
    expect(byName.deleteEndpoint).toBe('webhooks.delete');
    expect(byName.replayEvent).toBe('webhooks.replay');
  });

  it('every route requires the shared dual-mode project access guard, not a per-module clone', () => {
    for (const name of HANDLERS) {
      expect(guardsOf(name)).toContain('ProjectAccessGuard');
    }
  });

  it('declares its own DI tokens so the worker and the API share one contract', () => {
    expect(WEBHOOK_DESTINATIONS).toBe('WEBHOOK_DESTINATIONS');
    expect(typeof WEBHOOK_SECRET_KEY).toBe('string');
  });
});
