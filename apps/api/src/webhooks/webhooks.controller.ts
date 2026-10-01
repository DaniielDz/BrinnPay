import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';

import { ProjectAccessGuard } from '../common/project-scope/project-access.guard';
import {
  ProjectScope,
  type ProjectScope as ProjectScopeValue,
} from '../common/project-scope/project-scope';
import type { CursorPage } from '../organizations/cursor';
import { RequireCapability } from '../organizations/org-rbac.guard';
import { resolveRequestId } from '../request-id/request-id';
// Value imports, not `import type`: the global ValidationPipe resolves the DTO
// class from the emitted design:paramtypes metadata, so a type-only import would
// leave every body and query on this surface unvalidated.
import {
  WebhookDeliveryListQueryDto,
  WebhookEndpointListQueryDto,
  WebhookEventListQueryDto,
} from './dto/webhook-list-query.dto';
import {
  WebhookEndpointCreateDto,
  WebhookEndpointUpdateDto,
} from './dto/webhook-endpoint-create.dto';
import type {
  WebhookDeliveryResponse,
  WebhookEndpointCreatedResponse,
  WebhookEndpointResponse,
  WebhookEventResponse,
} from './webhook-types';
import { WebhooksService } from './webhooks.service';

/**
 * Webhook surface (phase 10 §4.4). All eight contracted operations are
 * project-nested and dual-mode, exactly like customers/payments/refunds:
 *
 * - **session mode** (dashboard JWT): project RBAC on the route's capability —
 *   404 non-member, 403 insufficient capability (§4.5/D10);
 * - **API-key mode** (`sk_…` token): the key's (project, environment) scope
 *   applies and the path project must be the key's project.
 *
 * `ProjectAccessGuard` is the shared extraction of the guard that phases 6, 7,
 * and 9 each cloned; it evaluates the capability **before** any endpoint, event, or
 * delivery row is read, so authorization precedes disclosure (§8).
 *
 * `Idempotency-Key` is deliberately not accepted on any mutation here: phase 1
 * §7.4 scopes idempotency to payment and refund creation (§4.4, D16).
 */
@Controller('projects/:project_id')
export class WebhooksController {
  constructor(private readonly webhooks: WebhooksService) {}

  // -------------------------------------------------------------------------
  // Endpoints
  // -------------------------------------------------------------------------

  @Get('webhook-endpoints')
  @UseGuards(ProjectAccessGuard)
  @RequireCapability({ capability: 'webhooks.read' })
  listEndpoints(
    @ProjectScope() scope: ProjectScopeValue,
    @Query() query: WebhookEndpointListQueryDto,
  ): Promise<CursorPage<WebhookEndpointResponse>> {
    return this.webhooks.listEndpoints(scope, query);
  }

  /**
   * 201 is the **only** response that carries the signing secret, and it is not
   * idempotency-key protected: a repeated create registers another endpoint with a
   * new secret, and duplicate URLs are allowed (D16).
   */
  @Post('webhook-endpoints')
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(ProjectAccessGuard)
  @RequireCapability({ capability: 'webhooks.create' })
  createEndpoint(
    @ProjectScope() scope: ProjectScopeValue,
    @Body() dto: WebhookEndpointCreateDto,
  ): Promise<WebhookEndpointCreatedResponse> {
    return this.webhooks.createEndpoint(scope, dto);
  }

  @Get('webhook-endpoints/:endpoint_id')
  @UseGuards(ProjectAccessGuard)
  @RequireCapability({ capability: 'webhooks.read' })
  retrieveEndpoint(
    @ProjectScope() scope: ProjectScopeValue,
    @Param('endpoint_id') endpointId: string,
  ): Promise<WebhookEndpointResponse> {
    return this.webhooks.retrieveEndpoint(scope, endpointId);
  }

  @Patch('webhook-endpoints/:endpoint_id')
  @UseGuards(ProjectAccessGuard)
  @RequireCapability({ capability: 'webhooks.update' })
  updateEndpoint(
    @ProjectScope() scope: ProjectScopeValue,
    @Param('endpoint_id') endpointId: string,
    @Body() dto: WebhookEndpointUpdateDto,
  ): Promise<WebhookEndpointResponse> {
    return this.webhooks.updateEndpoint(scope, endpointId, dto);
  }

  @Delete('webhook-endpoints/:endpoint_id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @UseGuards(ProjectAccessGuard)
  @RequireCapability({ capability: 'webhooks.delete' })
  async deleteEndpoint(
    @ProjectScope() scope: ProjectScopeValue,
    @Param('endpoint_id') endpointId: string,
  ): Promise<void> {
    await this.webhooks.deleteEndpoint(scope, endpointId);
  }

  // -------------------------------------------------------------------------
  // Deliveries and events
  // -------------------------------------------------------------------------

  @Get('webhook-endpoints/:endpoint_id/deliveries')
  @UseGuards(ProjectAccessGuard)
  @RequireCapability({ capability: 'webhooks.read' })
  listDeliveries(
    @ProjectScope() scope: ProjectScopeValue,
    @Param('endpoint_id') endpointId: string,
    @Query() query: WebhookDeliveryListQueryDto,
  ): Promise<CursorPage<WebhookDeliveryResponse>> {
    return this.webhooks.listDeliveries(scope, endpointId, query);
  }

  @Get('webhook-events')
  @UseGuards(ProjectAccessGuard)
  @RequireCapability({ capability: 'webhooks.read' })
  listEvents(
    @ProjectScope() scope: ProjectScopeValue,
    @Query() query: WebhookEventListQueryDto,
  ): Promise<CursorPage<WebhookEventResponse>> {
    return this.webhooks.listEvents(scope, query);
  }

  /**
   * Replay answers 202 with no body (D12) and is intentionally not
   * idempotency-key protected: repeated calls create repeated deliveries.
   */
  @Post('webhook-endpoints/:endpoint_id/events/:event_id/replay')
  @HttpCode(HttpStatus.ACCEPTED)
  @UseGuards(ProjectAccessGuard)
  @RequireCapability({ capability: 'webhooks.replay' })
  async replayEvent(
    @ProjectScope() scope: ProjectScopeValue,
    @Param('endpoint_id') endpointId: string,
    @Param('event_id') eventId: string,
    @Req() request: { id?: unknown },
  ): Promise<void> {
    await this.webhooks.replayEvent(scope, endpointId, eventId, resolveRequestId(request));
  }
}
