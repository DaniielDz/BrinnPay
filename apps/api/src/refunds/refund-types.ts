import { formatAmountMinor } from '../common/money/money';
import type { Environment } from '../projects/environment';

export interface RefundRow {
  id: string;
  paymentId: string;
  amountMinor: bigint;
  currency: string;
  status: string;
  reason: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface RefundResponse {
  id: string;
  payment_id: string;
  project_id: string;
  environment: Environment;
  amount: string;
  currency: 'usd';
  status: 'succeeded';
  reason: string | null;
  created_at: Date;
  updated_at: Date;
}

export function toRefundResponse(
  row: RefundRow,
  payment: { projectId: string; environment: string },
): RefundResponse {
  return {
    id: row.id,
    payment_id: row.paymentId,
    project_id: payment.projectId,
    environment: payment.environment as Environment,
    amount: formatAmountMinor(row.amountMinor),
    currency: row.currency as 'usd',
    status: row.status as 'succeeded',
    reason: row.reason,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
  };
}
