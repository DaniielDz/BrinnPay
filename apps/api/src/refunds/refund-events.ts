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
  /**
   * The API request that produced the event, when there is one (phase 10 §4.3.11,
   * F4). Recorded on the delivery rows the event produces; never part of the
   * envelope and never sent to a destination.
   */
  request_id?: string | null;
}
