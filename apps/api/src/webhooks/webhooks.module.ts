import { Module } from '@nestjs/common';

import { ApiKeysModule } from '../api-keys/api-keys.module';
import { ProjectScopeModule } from '../common/project-scope/project-scope.module';
import { WebhooksController } from './webhooks.controller';
import { WebhooksCoreModule } from './webhooks-core.module';
import { WebhooksService } from './webhooks.service';

/**
 * The webhook HTTP surface (phase 10 §4.1/§4.4): the eight contracted
 * endpoint/event/delivery/replay operations.
 *
 * Everything without an HTTP surface lives in {@link WebhooksCoreModule}, which
 * this module re-exports. That split is what lets the worker process (D14) share
 * the same services without booting controllers or the authentication stack they
 * depend on, and it is why the endpoint registry never leaks into the payments
 * and refunds modules: they import the core module's event port, not this one.
 *
 * The delivery *consumer* (the BullMQ worker) is deliberately not registered
 * here: D14 keeps it in a separate process with its own entrypoint, so this
 * process only enqueues.
 */
@Module({
  // `ApiKeysModule` is imported for the API-key half of the dual-mode boundary:
  // `ProjectAccessGuard` injects `ApiKeyAuthGuard`, and Nest resolves a
  // controller's guard in the declaring module's context — the same reason
  // customers, payments, and refunds import it.
  imports: [WebhooksCoreModule, ApiKeysModule, ProjectScopeModule],
  controllers: [WebhooksController],
  // `WEBHOOK_DESTINATIONS` is not re-declared here: the core module provides and
  // exports it, so the registration path and the delivery path read the same
  // policy from one place.
  providers: [WebhooksService],
  exports: [WebhooksService, WebhooksCoreModule],
})
export class WebhooksModule {}
