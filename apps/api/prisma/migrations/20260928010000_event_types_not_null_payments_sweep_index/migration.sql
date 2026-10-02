-- Phase 10 follow-up — two corrections to `20260928000000_webhooks`.
--
--   1. `webhook_endpoints.event_types` is created as a nullable `TEXT[]` while
--      the Prisma datamodel declares `String[]` (a list type is always required,
--      so it maps to `TEXT[] NOT NULL`). The migration and the datamodel
--      therefore disagree, and because `prisma migrate deploy` never diffs a
--      deployed database against the schema, CI never notices: the drift
--      surfaces later as a surprise `SET NOT NULL` migration from
--      `prisma migrate dev`.
--
--      It is also a correctness hole, not only a drift one. The existing
--      `webhook_endpoints_event_types_not_empty_check` reads
--      `array_length("event_types", 1) >= 1`, and a SQL `CHECK` **passes** on
--      `NULL` (it is satisfied unless it evaluates to false). A row with a NULL
--      subscription would therefore be accepted by the database while being an
--      endpoint that matches no event type and can never fire — exactly the
--      silent no-op that D1's closed-catalog rule exists to prevent. The API
--      layer already rejects a missing or empty subscription, so no legitimate
--      row can hold NULL; the `ALTER` below is what makes the database agree
--      with that invariant instead of merely trusting it.
--
--      The `NOT NULL` is applied *before* the `CHECK` is tightened, and a
--      pre-existing NULL is turned into a loud failure rather than silently
--      deleted: dropping a developer-registered endpoint is a data-loss action
--      that no migration should take on its own initiative.
--
--   2. `payments` gains a partial index for the advancement sweep (phase 10 D3,
--      `PaymentsService.advanceDuePayments`). The sweep runs on a 5 s default
--      interval and filters on `status IN ('pending','processing')` plus a
--      `created_at` bound, but the only indexes on `payments` are
--      `(project_id, environment)` and `(customer_id)` — neither of which the
--      sweep's predicate can use, so every pass was a sequential scan of the
--      whole table. Written as raw SQL for the same reason as the partial unique
--      index in the webhooks migration: Prisma cannot express a `WHERE` clause
--      on an index. The predicate is kept in sync with
--      `LEGAL` non-terminal statuses below.

-- AlterTable
ALTER TABLE "webhook_endpoints" ALTER COLUMN "event_types" SET NOT NULL;

-- Tighten the guard so it rejects NULL as well as the empty array. With the
-- column now `NOT NULL` the `array_length` form alone is sufficient; the
-- explicit `IS NOT NULL` keeps the invariant self-evident and survives a future
-- change that relaxes the column constraint.
ALTER TABLE "webhook_endpoints"
    DROP CONSTRAINT "webhook_endpoints_event_types_not_empty_check",
    ADD CONSTRAINT "webhook_endpoints_event_types_not_empty_check"
        CHECK ("event_types" IS NOT NULL AND array_length("event_types", 1) >= 1);

-- CreateIndex
-- The advancement sweep's exact predicate: a non-terminal payment whose
-- schedule has fully elapsed. Partial, so the index holds only the open
-- payments — terminal rows are the overwhelming majority as a project ages, and
-- they are never swept again. `created_at` leads so the elapsed-time bound is an
-- index range scan, and `id` is carried for the `orderBy: { id: 'asc' }` the
-- batched scan uses.
CREATE INDEX "payments_open_created_at_id_idx"
    ON "payments"("created_at", "id")
    WHERE "status" IN ('pending', 'processing');
