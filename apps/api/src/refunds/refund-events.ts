import { Injectable } from '@nestjs/common';

import type { Environment } from '../projects/environment';
import type { RefundResponse } from './refund-types';

export const REFUND_EVENTS = ['refund.created'] as const;
export interface RefundEvent {
  id: string;
  type: 'refund.created';
  created_at: Date;
  data: RefundResponse;
  environment: Environment;
  project_id: string;
}

export const REFUND_EVENT_SINK = 'REFUND_EVENT_SINK';
export interface RefundEventSink {
  emit(event: RefundEvent): void | Promise<void>;
}

@Injectable()
export class NoopRefundEventSink implements RefundEventSink {
  emit(event: RefundEvent): void {
    void event; // Phase 10 supplies persistence and delivery.
  }
}
