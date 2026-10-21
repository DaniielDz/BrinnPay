#!/usr/bin/env node
/**
 * Phase 17 browser runs (D1): clears the rate-limiter's Redis state before an
 * API process starts, so the bounded browser suite (§12.5) begins from known
 * counters instead of inheriting a previous run's window.
 *
 * It deletes **only** keys under the limiter namespace
 * (`brinnpay:rl:v1` — the single namespace from
 * `apps/api/src/rate-limiting/rate-limit-counter.service.ts`, rule 5).
 * Queues, sessions and business data live under other keys and in PostgreSQL
 * and are never touched.
 *
 * Destructive operation, therefore guarded: the target host must be loopback
 * (localhost / 127.0.0.1 / ::1). A `REDIS_URL` pointing anywhere else — a
 * shared or managed instance — is refused with a non-zero exit, so this script
 * can never wipe rate-limit state outside the local run it exists for. The
 * target host and database are printed (never keys, never credentials) before
 * anything is deleted.
 *
 * Non-secret test tooling: it reads `REDIS_URL` only and exits non-zero on any
 * failure so the caller (`playwright.config.ts` webServer command) aborts the
 * run loudly instead of starting against stale state.
 */
import { Redis } from 'ioredis';

const LIMITER_NAMESPACE = 'brinnpay:rl:v1';

/** The only hosts this script may touch (URL hostnames, brackets optional). */
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

const rawUrl = process.env.REDIS_URL ?? 'redis://localhost:6379/15';

let target;
try {
  target = new URL(rawUrl);
} catch {
  console.error('brinnpay: refusing to clear rate-limit state: REDIS_URL is not a valid URL.');
  process.exit(1);
}

const host = target.hostname;
if (!LOOPBACK_HOSTS.has(host)) {
  console.error(
    `brinnpay: refusing to clear rate-limit state: host "${host}" is not loopback ` +
      '(localhost/127.0.0.1/::1). Set REDIS_URL to the local instance and retry.',
  );
  process.exit(1);
}

/** Database index only — never the URL itself (it may carry credentials). */
const db = target.pathname.replace(/^\//, '') || '0';
console.log(`brinnpay: rate-limit flush target ${host} db ${db}`);

const redis = new Redis(rawUrl, {
  maxRetriesPerRequest: 1,
  commandTimeout: 5_000,
  enableReadyCheck: true,
});

try {
  let cursor = '0';
  let removed = 0;
  do {
    const [next, keys] = await redis.scan(cursor, 'MATCH', `${LIMITER_NAMESPACE}*`, 'COUNT', 500);
    cursor = next;
    if (keys.length > 0) removed += await redis.del(...keys);
  } while (cursor !== '0');
  console.log(`brinnpay: rate-limit state cleared (${removed} keys)`);
  redis.disconnect();
  process.exit(0);
} catch (error) {
  console.error(
    `brinnpay: failed to clear rate-limit state: ${error instanceof Error ? error.message : 'unknown error'}`,
  );
  redis.disconnect();
  process.exit(1);
}
