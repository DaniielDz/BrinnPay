import type { Environment } from '../projects/environment';
import type { WebhookEnvelope } from './webhook-events';
import type { DeliveryStatus } from './webhook-retry';

/**
 * Contract projections (phase 10 §4.4). Snake_case mirrors of the rows, matching
 * the way every other module projects its resource. None of them ever carries
 * the signing secret: `WebhookEndpointCreated` is the only shape that includes
 * it, and only the 201 create response is ever built from it (§4.4, D8).
 */

/** `WebhookEndpoint` — never contains the secret. */
export interface WebhookEndpointResponse {
  id: string;
  project_id: string;
  environment: Environment;
  url: string;
  event_types: string[];
  enabled: boolean;
  created_at: Date;
  updated_at: Date;
}

/** `WebhookEndpointCreated` — the plaintext secret appears exactly once. */
export interface WebhookEndpointCreatedResponse extends WebhookEndpointResponse {
  signing_secret: string;
}

/** `WebhookEvent` — exposes the exact stored envelope. */
export type WebhookEventResponse = WebhookEnvelope;

/** `WebhookDelivery` — the per-(event, endpoint) aggregate (D4). */
export interface WebhookDeliveryResponse {
  id: string;
  endpoint_id: string;
  event_id: string;
  status: DeliveryStatus;
  attempts: number;
  response_status: number | null;
  /** Bounded, sanitized summary of the last failure; never a response body. */
  last_error: string | null;
  /** When the next retry is scheduled (D5); null when none is pending. */
  next_attempt_at: Date | null;
  /** True when the delivery was created by a manual replay (D12). */
  is_replay: boolean;
  created_at: Date;
  updated_at: Date;
}

/** Row shapes the mappers accept (structural, so queries can select narrowly). */
export interface EndpointRow {
  id: string;
  projectId: string;
  environment: string;
  url: string;
  eventTypes: string[];
  enabled: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export function toEndpointResponse(row: EndpointRow): WebhookEndpointResponse {
  return {
    id: row.id,
    project_id: row.projectId,
    environment: row.environment as Environment,
    url: row.url,
    event_types: row.eventTypes,
    enabled: row.enabled,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
  };
}

export function toEndpointCreatedResponse(
  row: EndpointRow,
  signingSecret: string,
): WebhookEndpointCreatedResponse {
  return { ...toEndpointResponse(row), signing_secret: signingSecret };
}

export interface DeliveryRow {
  id: string;
  endpointId: string;
  eventId: string;
  status: string;
  attempts: number;
  responseStatus: number | null;
  lastError: string | null;
  nextAttemptAt: Date | null;
  isReplay: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export function toDeliveryResponse(row: DeliveryRow): WebhookDeliveryResponse {
  return {
    id: row.id,
    endpoint_id: row.endpointId,
    event_id: row.eventId,
    status: row.status as DeliveryStatus,
    attempts: row.attempts,
    response_status: row.responseStatus,
    last_error: row.lastError,
    next_attempt_at: row.nextAttemptAt,
    is_replay: row.isReplay,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
  };
}

export interface EventRow {
  id: string;
  projectId: string;
  environment: string;
  type: string;
  payload: unknown;
  createdAt: Date;
}

/**
 * The stored `payload` already *is* the envelope, so it is returned as stored —
 * no re-projection, no risk of the listing and the delivered bytes disagreeing
 * (§4.3.2).
 */
export function toEventResponse(row: EventRow): WebhookEventResponse {
  return row.payload as WebhookEnvelope;
}
