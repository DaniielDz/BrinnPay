import { Inject, Injectable } from '@nestjs/common';

import { ApiError } from '../common/errors/api-error';
import { ErrorCode } from '../common/errors/error-code';
import type { ProjectScope } from '../common/project-scope/project-scope';
import { uuidv7 } from '../common/uuid/uuid';
import {
  buildCursorPage,
  cursorToWhere,
  DEFAULT_LIST_LIMIT,
  type CursorPage,
} from '../organizations/cursor';
import { PrismaService } from '../prisma/prisma.service';
import type { Environment } from '../projects/environment';
import { isUuidLike } from '../projects/projects.service';
import type {
  WebhookEndpointCreateDto,
  WebhookEndpointUpdateDto,
} from './dto/webhook-endpoint-create.dto';
import {
  resolveDeliveryStatusFilter,
  resolveEventTypeFilter,
  type WebhookDeliveryListQueryDto,
  type WebhookEndpointListQueryDto,
  type WebhookEventListQueryDto,
} from './dto/webhook-list-query.dto';
import {
  encryptWebhookSecret,
  generateWebhookSecret,
  WEBHOOK_SECRET_KEY,
} from './webhook-crypto';
import { isWebhookEventType, WEBHOOK_EVENT_TYPES } from './webhook-events';
import { WebhookQueueService } from './webhook-queue.service';
import {
  toDeliveryResponse,
  toEndpointCreatedResponse,
  toEndpointResponse,
  toEventResponse,
  type WebhookDeliveryResponse,
  type WebhookEndpointCreatedResponse,
  type WebhookEndpointResponse,
  type WebhookEventResponse,
} from './webhook-types';
import {
  validateWebhookUrl,
  WEBHOOK_DESTINATIONS,
  type DestinationPolicy,
} from './webhook-url';

const ENDPOINT_NOT_FOUND = () =>
  new ApiError(ErrorCode.NOT_FOUND, 'Webhook endpoint not found', 404);
const EVENT_NOT_FOUND = () => new ApiError(ErrorCode.NOT_FOUND, 'Webhook event not found', 404);

/**
 * Generic 422 for the replay preconditions (D12): it must not reveal more about
 * an endpoint's configuration than the caller already knows.
 */
const REPLAY_PRECONDITION = () =>
  new ApiError(
    ErrorCode.BUSINESS_RULE_VIOLATION,
    'The webhook endpoint cannot receive a replay of this event',
    422,
  );

/**
 * The webhook endpoint registry, the event and delivery listings, and manual
 * replay (phase 10 §4.4/§4.5/§5.6).
 *
 * The dual-mode guard has already authenticated the request, pinned the path
 * project to the caller's project, and evaluated the route capability **before
 * any data was read** (§8 — authorization before disclosure). This service
 * enforces what remains:
 *
 * - the environment rule (mirroring phase 7 D1): the session-only list
 *   operations require an explicit `environment` (400 when missing) because TEST
 *   and LIVE data is never mixed; an API key derives it and rejects a conflicting
 *   explicit value with 422;
 * - project/environment scoping of every endpoint, event, and delivery lookup, so
 *   a cross-project or cross-environment id is a 404 that reveals nothing;
 * - the closed-catalog subscription rule (D1) and URL validation (§4.6);
 * - the replay preconditions (D12);
 * - never returning the signing secret (D8): only the 201 create response
 *   includes it.
 */
@Injectable()
export class WebhooksService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly queue: WebhookQueueService,
    @Inject(WEBHOOK_SECRET_KEY) private readonly secretKey: Buffer,
    @Inject(WEBHOOK_DESTINATIONS) private readonly destinations: DestinationPolicy,
  ) {}

  // -------------------------------------------------------------------------
  // Endpoints (§4.4)
  // -------------------------------------------------------------------------

  /** List the environment's endpoints, UUIDv7 ascending, never with a secret. */
  async listEndpoints(
    scope: ProjectScope,
    query: WebhookEndpointListQueryDto,
  ): Promise<CursorPage<WebhookEndpointResponse>> {
    const environment = this.resolveListEnvironment(scope, query.environment);
    const limit = query.limit ?? DEFAULT_LIST_LIMIT;
    const rows = await this.prisma.webhookEndpoint.findMany({
      where: {
        projectId: scope.project_id,
        environment,
        ...(cursorToWhere(query.cursor) ?? {}),
      },
      orderBy: { id: 'asc' },
      take: limit + 1,
    });
    return buildCursorPage(rows.map(toEndpointResponse), limit);
  }

  /**
   * Register an endpoint. The signing secret is generated with a CSPRNG, encrypted
   * for storage (D8), and returned in this response **only**. Duplicate URLs are
   * accepted for the same project/environment with no uniqueness conflict (D16).
   */
  async createEndpoint(
    scope: ProjectScope,
    dto: WebhookEndpointCreateDto,
  ): Promise<WebhookEndpointCreatedResponse> {
    const environment = this.resolveBodyEnvironment(scope, dto.environment);
    const url = validateWebhookUrl(dto.url, this.destinations);
    const eventTypes = this.validateSubscription(dto.event_types);

    const secret = generateWebhookSecret();
    const stored = encryptWebhookSecret(secret, this.secretKey);
    const now = new Date();

    const row = await this.prisma.webhookEndpoint.create({
      data: {
        id: uuidv7(),
        projectId: scope.project_id,
        environment,
        url,
        eventTypes,
        enabled: dto.enabled ?? true,
        secretCipher: stored.ciphertext,
        secretIv: stored.iv,
        secretAuthTag: stored.authTag,
        createdAt: now,
        updatedAt: now,
      },
    });

    return toEndpointCreatedResponse(row, secret);
  }

  /**
   * Retrieve an endpoint. The environment is derived from the addressed endpoint
   * (F6), so this is not an environment parameter; in API-key mode an endpoint of
   * the key's project but the other environment is a 404.
   */
  async retrieveEndpoint(
    scope: ProjectScope,
    endpointId: string,
  ): Promise<WebhookEndpointResponse> {
    return toEndpointResponse(await this.findScopedEndpoint(scope, endpointId));
  }

  /**
   * Partial update of `url`, `event_types`, and `enabled`. The signing secret is
   * never rotated (D8: recovery is delete and recreate). An empty body is a 400 —
   * a patch with no field is a caller mistake, not a successful no-op.
   */
  async updateEndpoint(
    scope: ProjectScope,
    endpointId: string,
    dto: WebhookEndpointUpdateDto,
  ): Promise<WebhookEndpointResponse> {
    const endpoint = await this.findScopedEndpoint(scope, endpointId);

    if (dto.url === undefined && dto.event_types === undefined && dto.enabled === undefined) {
      throw ApiError.validation({
        fields: [
          {
            field: 'url',
            errors: ['At least one of url, event_types, or enabled must be provided'],
          },
        ],
      });
    }

    const data: {
      url?: string;
      eventTypes?: string[];
      enabled?: boolean;
      updatedAt: Date;
    } = { updatedAt: new Date() };
    if (dto.url !== undefined) {
      data.url = validateWebhookUrl(dto.url, this.destinations);
    }
    if (dto.event_types !== undefined) {
      data.eventTypes = this.validateSubscription(dto.event_types);
    }
    if (dto.enabled !== undefined) {
      data.enabled = dto.enabled;
    }

    return toEndpointResponse(
      await this.prisma.webhookEndpoint.update({ where: { id: endpoint.id }, data }),
    );
  }

  /**
   * Delete an endpoint. Its delivery records are cascaded by the foreign key; the
   * project-scoped events survive and stay listable and replayable to other
   * endpoints (D11, §4.3.10). No delete-time business rule is invented, so the
   * contract's 422 on this operation stays reserved and unused (F8).
   */
  async deleteEndpoint(scope: ProjectScope, endpointId: string): Promise<void> {
    const endpoint = await this.findScopedEndpoint(scope, endpointId);
    await this.prisma.webhookEndpoint.delete({ where: { id: endpoint.id } });
  }

  // -------------------------------------------------------------------------
  // Deliveries and events (§4.4)
  // -------------------------------------------------------------------------

  /**
   * Cursor-paginated deliveries of one endpoint, ordered consistently with the
   * shared cursor helper, with the optional `status` filter (D15). The filter
   * narrows within the caller's project/environment and never changes cursor
   * semantics, so pagination stays stable and non-overlapping.
   */
  async listDeliveries(
    scope: ProjectScope,
    endpointId: string,
    query: WebhookDeliveryListQueryDto,
  ): Promise<CursorPage<WebhookDeliveryResponse>> {
    const endpoint = await this.findScopedEndpoint(scope, endpointId);
    const status = resolveDeliveryStatusFilter(query.status);
    const limit = query.limit ?? DEFAULT_LIST_LIMIT;

    const rows = await this.prisma.webhookDelivery.findMany({
      where: {
        endpointId: endpoint.id,
        ...(status ? { status } : {}),
        ...(cursorToWhere(query.cursor) ?? {}),
      },
      orderBy: { id: 'asc' },
      take: limit + 1,
    });
    return buildCursorPage(rows.map(toDeliveryResponse), limit);
  }

  /**
   * Cursor-paginated events of the environment, ascending by id, exposing the
   * exact stored envelope, with the optional `type` filter (D15).
   */
  async listEvents(
    scope: ProjectScope,
    query: WebhookEventListQueryDto,
  ): Promise<CursorPage<WebhookEventResponse>> {
    const environment = this.resolveListEnvironment(scope, query.environment);
    const type = resolveEventTypeFilter(query.type);
    const limit = query.limit ?? DEFAULT_LIST_LIMIT;

    const rows = await this.prisma.webhookEvent.findMany({
      where: {
        projectId: scope.project_id,
        environment,
        ...(type ? { type } : {}),
        ...(cursorToWhere(query.cursor) ?? {}),
      },
      orderBy: { id: 'asc' },
      take: limit + 1,
    });
    return buildCursorPage(rows.map(toEventResponse), limit);
  }

  /**
   * Replay (§5.6, D12). Targets **one** (event, endpoint) pair and creates a
   * **new** delivery referencing the same event, so the destination sees the same
   * envelope `id`, `created_at`, and payload as the original delivery. The
   * earlier delivery's outcome is never modified, and no new event row is
   * created.
   *
   * Preconditions: the endpoint exists in the addressed project/environment; the
   * event exists, belongs to the same project **and** environment, and is still
   * retained; the endpoint is enabled and still subscribed to the event type. The
   * last two are 422 with a generic message; a foreign or unknown event is 404.
   *
   * Replay is intentionally **not** idempotency-key protected: repeated calls
   * create repeated deliveries.
   */
  async replayEvent(
    scope: ProjectScope,
    endpointId: string,
    eventId: string,
    requestId?: string,
  ): Promise<void> {
    const endpoint = await this.findScopedEndpoint(scope, endpointId);
    if (!isUuidLike(eventId)) {
      throw EVENT_NOT_FOUND();
    }

    // The endpoint is the address, so its environment bounds the event lookup too
    // (F6). In API-key mode `findScopedEndpoint` has already guaranteed the two
    // coincide.
    const event = await this.prisma.webhookEvent.findFirst({
      where: {
        id: eventId,
        projectId: scope.project_id,
        environment: endpoint.environment,
      },
    });
    if (!event) {
      throw EVENT_NOT_FOUND();
    }

    if (!endpoint.enabled || !endpoint.eventTypes.includes(event.type)) {
      throw REPLAY_PRECONDITION();
    }

    const now = new Date();
    const delivery = await this.prisma.webhookDelivery.create({
      data: {
        id: uuidv7(),
        endpointId: endpoint.id,
        eventId: event.id,
        status: 'pending',
        attempts: 0,
        responseStatus: null,
        lastError: null,
        nextAttemptAt: now,
        // The replay request is what caused this delivery (phase 1 §7.7).
        requestId: requestId ?? null,
        isReplay: true,
        createdAt: now,
        updatedAt: now,
      },
    });

    // Best-effort: the delivery row is durable, and reconciliation re-queues a
    // job that could not be added here (§4.3.7).
    await this.queue.enqueueDelivery(delivery.id, 1, 0);
  }

  // -------------------------------------------------------------------------
  // Environment resolution (mirrors phase 7 D1)
  // -------------------------------------------------------------------------

  /**
   * Session mode: the `environment` query parameter is required — TEST/LIVE data
   * is never mixed, so a session request without an explicit environment cannot
   * be served (400 field error). API-key mode derives it from the key and rejects
   * a conflicting explicit value with 422.
   */
  private resolveListEnvironment(
    scope: ProjectScope,
    explicit: Environment | undefined,
  ): Environment {
    if (scope.mode === 'api_key') {
      if (explicit && explicit !== scope.environment) {
        this.environmentMismatch();
      }
      return scope.environment;
    }
    if (!explicit) {
      throw ApiError.validation({
        fields: [
          {
            field: 'environment',
            errors: ['environment is required for session-authenticated requests'],
          },
        ],
      });
    }
    return explicit;
  }

  /** Create: session → body value; API key → must equal the key's environment. */
  private resolveBodyEnvironment(scope: ProjectScope, body: Environment): Environment {
    if (scope.mode === 'api_key' && body !== scope.environment) {
      this.environmentMismatch();
    }
    return scope.mode === 'api_key' ? scope.environment : body;
  }

  private environmentMismatch(): never {
    throw new ApiError(
      ErrorCode.BUSINESS_RULE_VIOLATION,
      'Environment does not match the API key scope',
      422,
      { field: 'environment' },
    );
  }

  // -------------------------------------------------------------------------
  // Scoping and validation helpers
  // -------------------------------------------------------------------------

  /**
   * Loads an endpoint within the addressed project and, in API-key mode, within
   * the key's environment. A malformed id, a cross-project id, or an endpoint of
   * the other environment is indistinguishable from an unknown one (404
   * non-disclosure). ID opacity is never treated as a control (§8).
   */
  private async findScopedEndpoint(scope: ProjectScope, endpointId: string) {
    if (!isUuidLike(endpointId)) {
      throw ENDPOINT_NOT_FOUND();
    }
    const endpoint = await this.prisma.webhookEndpoint.findFirst({
      where: {
        id: endpointId,
        projectId: scope.project_id,
        ...(scope.mode === 'api_key' ? { environment: scope.environment } : {}),
      },
    });
    if (!endpoint) {
      throw ENDPOINT_NOT_FOUND();
    }
    return endpoint;
  }

  /**
   * D1: the catalog is closed, so an unknown or malformed type is a 400 field
   * error rather than a stored value. Accepting one would create an endpoint that
   * can never fire and would hide the typo behind a silent no-op. Entries must be
   * distinct and non-empty (§4.6).
   */
  private validateSubscription(value: unknown[]): string[] {
    const seen = new Set<string>();
    for (const entry of value) {
      if (typeof entry !== 'string' || !isWebhookEventType(entry)) {
        throw ApiError.validation({
          fields: [
            {
              field: 'event_types',
              errors: [
                `event_types entries must be catalog types: ${WEBHOOK_EVENT_TYPES.join(', ')}`,
              ],
            },
          ],
        });
      }
      if (seen.has(entry)) {
        throw ApiError.validation({
          fields: [{ field: 'event_types', errors: ['event_types must not contain duplicates'] }],
        });
      }
      seen.add(entry);
    }
    if (seen.size === 0) {
      throw ApiError.validation({
        fields: [{ field: 'event_types', errors: ['event_types must contain at least one event type'] }],
      });
    }
    return [...seen];
  }
}
