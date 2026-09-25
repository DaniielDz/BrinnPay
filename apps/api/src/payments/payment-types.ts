import { formatAmountMinor } from '../common/money/money';
import type { Environment } from '../projects/environment';

/** Contract `Payment.status` (phase 7 §4.6). Stored as an app-validated
 *  `varchar` (phase 4 D10 pattern). */
export const PAYMENT_STATUSES = ['pending', 'processing', 'succeeded', 'failed'] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

export function isPaymentStatus(value: string): value is PaymentStatus {
  return (PAYMENT_STATUSES as readonly string[]).includes(value);
}

/** `Payment` as contracted (phase 7 §4.2): `amount` is a decimal string
 *  (ADR-0002 — BigInt minor units are converted before any JSON
 *  serialization), `currency` is always `usd` in the MVP (ADR-0003),
 *  `failure_code` is `null` unless `status = failed` (catalog is Phase 16),
 *  and `description` is `null` when absent (D9). */
export interface PaymentResponse {
  id: string;
  project_id: string;
  environment: Environment;
  customer_id: string;
  amount: string;
  currency: 'usd';
  status: PaymentStatus;
  failure_code: string | null;
  description: string | null;
  created_at: Date;
  updated_at: Date;
}

/** The persisted payment row (the generated Prisma client model). */
export interface PaymentRow {
  id: string;
  projectId: string;
  environment: string;
  customerId: string;
  amountMinor: bigint;
  currency: string;
  status: string;
  failureCode: string | null;
  description: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/** Maps a persisted row to the contracted projection. The `status`/`currency`
 *  casts are safe: both are app-validated on write (phase 4 D10 pattern). */
export function toPaymentResponse(row: PaymentRow): PaymentResponse {
  return {
    id: row.id,
    project_id: row.projectId,
    environment: row.environment as Environment,
    customer_id: row.customerId,
    amount: formatAmountMinor(row.amountMinor),
    currency: row.currency as 'usd',
    status: row.status as PaymentStatus,
    failure_code: row.failureCode,
    description: row.description,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
  };
}