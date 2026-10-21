# Phase 19 — Load-test harness (k6)

Reference implementation of `.ai/phases/phase-19-performance.md` (decisions
D1–D9). Local, manual load testing only — **never wired into CI** (D4), and
it exercises the **local stack only** (spec §4 rule 6).

## What this does

`pnpm loadtest` boots a dedicated, disposable BrinnPay stack, seeds a
contract-valid corpus directly in PostgreSQL (D9), executes the committed
scenario catalog S1–S8 in a fixed order (§16), and writes per-scenario
summary artifacts to `loadtest/results/<runId>/`. The committed baseline and
findings docs are curated from those artifacts:

- `docs/performance-baseline.md` — p50/p95/p99 per scenario, environment,
  date, commit (spec §4 rule 4).
- `docs/performance-findings.md` — findings log with dispositions (F1–F11).

## Prerequisites

- Node ≥ 22 and pnpm (repo toolchain).
- Docker with Compose v2.
- ~4 GB free RAM for the load stack.
- **k6 is not required on the host**: scenarios run in the pinned
  `grafana/k6:2.3.0` image (pulled on first use).

No `.env` file is required. Non-secret knobs live in `.env.example`;
secrets (`WEBHOOK_ENCRYPTION_KEY`, `JWT_SECRET`) are read from the existing
`apps/api/.env` / `docker/.env` and passed to containers via the
environment — they are never printed, logged or committed.

## Quickstart (clean checkout)

```bash
pnpm install          # workspace + loadtest deps (tsc/eslint are local)
pnpm loadtest         # full catalog: boot → seed → S8…S7 → teardown
```

Useful flags (all optional):

| Flag | Effect |
| --- | --- |
| `--list` | Print the catalog and exit. |
| `--scenario <id>` / `-s <id>` | Run one scenario (stack still boots/seeds). |
| `--keep-stack` | Skip teardown; keep the stack + state for iteration. |
| `--no-reset` | With `--keep-stack`: reuse the seeded stack, don't re-seed. |
| `--help` | Usage. |

Validation without load (AC9 — what CI would run if this ever graduates
from "manual"):

```bash
pnpm loadtest:inspect   # docker run grafana/k6:2.3.0 inspect on every scenario
```

## How the stack is isolated

The runner uses a **separate compose project** so your dev stack is
untouched and `down -v` only ever destroys load-run data:

- project `brinnpay-loadtest`, network `brinnpay-loadtest_default`
- ports: API **3100**, Postgres **5543**, Redis **6380**, web **3201**
- webhook receiver container (path-based 500s for failure scenarios)
- k6 runs in-network (`--network brinnpay-loadtest_default`, target
  `http://api:3000/api/v1`) — no host port required for the scenarios

### Reset procedure

The runner resets automatically: every run starts with
`docker compose -p brinnpay-loadtest -f docker/compose.yml down -v`
unless you pass `--keep-stack`. To reset manually:

```bash
docker compose -p brinnpay-loadtest -f docker/compose.yml down -v
rm -f loadtest/.state/state.json    # local seed state (gitignored, mode 600)
```

## Catalog order (committed, fixed)

| # | Scenario | Profile |
| --- | --- | --- |
| 1 | `s8-mixed-steady-state` | 10 VU × 90s, 40% create / 35% list / 25% refund |
| 2 | `s1-auth-session` | 5 VU × 60s, 4 fresh accounts + 1 AR-3 account-scope probe |
| 3 | `s2-payments-write` | 10 VU × 60s, 60% plain create / 40% idempotent pair |
| 4 | `s3-payments-read` | 10 VU × 60s, 50% cursor list / 50% retrieve (**no settle before** — S2's backlog is the measurement) |
| 5 | `s4-customers-search` | 10 VU × 60s, 60% `q=` search / 40% list |
| — | *settle* | poll open payments → 0 (max 300s) |
| 6 | `s5-webhook-plane` | 5 VU × 60s, uneven 4:1 project split (fairness/pending-bound evidence) |
| — | *settle* | again, before amplification |
| 7 | `s6-unmatched-404` | 10 VU × 60s, unknown-path 404s (request-log amplification) |
| 8 | `s7-dashboard-session` | 5 VU × 60s, weighted dashboard API emulation + static `apps/web` review |
| — | *final settle* | records end state |

Settle points follow the spec: **no settle after S2** (D-continuity),
settle before/after S5, final settle after S7. Webhook delivery retries from
earlier scenarios may still be draining (backoff up to ~15 min) during later
ones — that overlap is expected and documented, not waited for.

## Rate-limit overrides (AC7)

Only local knobs are raised so the scenarios measure the runtime instead of
the limiter. **No class, algorithm or catalog entry changes**, and the
*account* scope (ADR-0037 AR-3) is untouched:

| Override | Value | Why |
| --- | --- | --- |
| `RATE_LIMIT_READ_MAX` | 200000 | read-heavy scenarios S3/S4/S7 |
| `RATE_LIMIT_WRITE_MAX` | 200000 | write bursts S2/S8 |
| `RATE_LIMIT_WEBHOOK_ENDPOINT_CREATE_MAX` | 1000 | seeder creates 5 endpoints + retries |
| `AUTH_RATE_LIMIT_IP_LOGIN_MAX` | 100000 | S1 creates a fresh account per iteration |
| `AUTH_RATE_LIMIT_IP_READ_MAX` | 100000 | authenticated reads inside scenarios |

Values are recorded verbatim in each run's `manifest.json` and in
`docs/performance-baseline.md`. **Expected behavior:** S1's dedicated probe
VU still hits the unmodified `AUTH_RATE_LIMIT_ACCOUNT_LOGIN_MAX` (10/15 min
per account) and should produce 429s — that is the AR-3 fairness evidence,
not a harness bug.

## Artifacts

```
loadtest/results/<runId>/
  manifest.json     runId, date, git commit, machine, ports, overrides, exit codes
  samples.jsonl     time-series: open payments by project, queue depth, receiver stats
  <scenario>.json   normalized summary (p50/p95/p99, rates, custom metrics)
  <scenario>.log    raw k6 stdout/stderr
  SUMMARY.txt       concatenated text summaries
```

`loadtest/results/` and `loadtest/.state/` are gitignored. Never commit
run artifacts containing state-file material — the state file holds a
plaintext password, project ids and endpoint URLs (mode 600, local only);
scripts never print it.

## Seeding (D9) in one paragraph

Primary corpus: 3000 customers / 5000 payments; secondary (isolation): 100 /
200. A 5 + 5 scaffold is created **through the API** (so the harness proves
the documented contract end-to-end), then the corpus is bulk-inserted with
contract-valid values only (enforced by `lib/corpus.mjs`, unit-tested):
uuidv7 ids that sort chronologically, amounts as positive integer cents,
statuses from the domain with failure codes paired to
`decline:<code>` scenarios, ≤ 50 open payments left for the sweep, and
placeholder `@loadtest.invalid` e-mails (no PII, ever). Five webhook
endpoints (three primary, two secondary) point at the receiver; signing
secrets are written to the state file only.

## Unit tests

```bash
pnpm --filter @brinnpay/loadtest test
```

Covers the pure modules: summary projection (the exact bytes that become the
baseline), corpus builders (contract-valid SQL), uuidv7 (RFC 9562 shape,
time ordering). Scenario scripts are `.ts` for k6 and are validated by
`pnpm loadtest:inspect` instead.

## Troubleshooting

- **Port already allocated** — something else holds 3100/5543/6380/3201;
  stop it or edit `PORTS` in `scripts/run.mjs`.
- **`k6: not found`** — don't install k6; use `pnpm loadtest` (containerized).
- **Stuck at settle** — inspect with `--keep-stack`, then
  `docker compose -p brinnpay-loadtest ... logs api` (the sweep settles
  ~20 payments/s; a large open tail can legitimately take a few minutes).
- **Receiver 500s look alarming** — paths containing `/fail/` *intentionally*
  return 500 to exercise retry backoff.
