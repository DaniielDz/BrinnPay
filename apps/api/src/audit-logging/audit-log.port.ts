import type { Prisma } from '../../generated/prisma/client';
import type { AuditCapture } from './audit-actions';

/**
 * Transaction handle the audit capability writes through — the *emitting*
 * module's transaction, never its own connection (phase 12 §6.2, D7). The
 * port is typed structurally so consumers never depend on Prisma namespaces
 * beyond the shared client type.
 */
export type AuditTransaction = Prisma.TransactionClient;

/**
 * The inbound boundary domain modules call to trigger audit capture
 * (phase 12 §4.1/§15 — the `WebhookEventPort` shape of Phase 10 §4.1).
 *
 * **Transactional (`record`).** The caller passes the transaction it already
 * owns; the audit rows are inserted inside it, so an audited change and its
 * entries commit or roll back together. An unknown action or an unsatisfiable
 * scope makes `record` throw, which rolls the caller's transaction back:
 * there is no committed change without its audit entry (fail-closed, D7/AC4).
 *
 * **Best-effort (`captureAuth`).** Authentication outcome events (§5.2 other
 * than `user.registered`) have no transaction to join, so they are written on
 * the capability's own connection; failures are logged (action, organization
 * id, error class — never the payload) and dropped (§6.2). A login must not
 * fail because the audit store failed.
 */
export const AUDIT_LOG_PORT = 'AUDIT_LOG_PORT';

export interface AuditLogPort {
  /**
   * Writes the entry (or the D4 membership fan-out for auth captures that
   * specify it) inside the caller's transaction. Fail-closed: any failure
   * propagates so the caller's transaction rolls back.
   */
  record(tx: AuditTransaction, capture: AuditCapture): Promise<void>;

  /**
   * Records an authentication outcome best-effort, outside any caller
   * transaction (§6.2). Never throws; failures are logged and dropped.
   */
  captureAuth(capture: AuditCapture): Promise<void>;
}
