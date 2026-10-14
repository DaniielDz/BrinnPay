# Performance Baseline — Phase 19

Committed performance baseline (Phase 19 D3(a), "baseline-then-record"). This
artifact is the standing regression-relative bar: **no regression beyond the
recorded variance band plus a near-zero contract-level error rate**. There are
no absolute SLOs (Q1 waived; F6/D3). Numbers below are from a developer
machine and are **not capacity claims** (F7): Phases 22/24 re-baseline on
deployment-class hardware per ADR-0038.

- **Date:** 2026-10-14
- **Commit measured:** `46c2692` (+ this phase's harness/fix commits on
  `feature/phase-19-performance`; the harness itself changes no API behavior)
- **Baseline run:** `run-20261014191233-c7b4` (run C — chosen as primary
  because it is the only run with in-scenario worker-plane samples; the async
  sampler fix landed after runs A/B)
- **Comparison runs:** `run-20261014182659-3e88` (A), `run-20261014184707-68a4`
  (B)
- **Raw results:** `loadtest/results/<run-id>/` — local-only, never committed
  (D4), never in CI
- **Findings/dispositions:** `docs/performance-findings.md`, ADR-0038, ADR-0039

## 1. Environment

| Item | Value |
| --- | --- |
| Machine | Intel Core i3-2120 @ 3.30 GHz, 4 cores, 7.7 GB RAM, Linux Mint 22.3 (kernel 6.14), Docker 29.8.1, Node v24.21.0 |
| Stack | dedicated compose project `brinnpay-loadtest` (never the dev stack): API :3100, PostgreSQL 17 :5543, Redis 7 :6380, webhook receiver :4090 |
| Load tool | grafana/k6:2.3.0, containerized, scenarios validated with `pnpm loadtest:inspect` |
| Corpus (D9) | 3 100 customers / 5 200 payments (primary 2 995c/4 995p, secondary 100c/200p), 5 webhook endpoints (1 fail-path per project), bulk-SQL seeder; credentials only in gitignored `loadtest/.state/` |
| Rate limits (F4/AC7) | load-only env overrides on the compose project: `RATE_LIMIT_READ_MAX/WRITE_MAX=200000`, `AUTH_RATE_LIMIT_IP_LOGIN_MAX/IP_READ_MAX=100000`, `RATE_LIMIT_WEBHOOK_ENDPOINT_CREATE_MAX=1000`. Catalog, algorithm, and repository defaults untouched. |

## 2. Procedure (ADR-0038 §2)

```
pnpm loadtest          # reset stack → migrate → seed → S1–S8 → settles → teardown
pnpm loadtest:inspect  # validate all 8 scenarios against the k6 image
pnpm --filter @brinnpay/loadtest test   # harness unit tests (receiver, summary, corpus, uuidv7)
```

Each run produces `loadtest/results/<run-id>/` (manifest, per-scenario k6
summaries + exports, `samples.jsonl` at 5 s cadence **in-scenario** since the
async-runner fix, `SUMMARY.txt`). Reproducing the baseline: same machine class,
same procedure, quiet machine; compare medians/throughput against the band in
§5.

## 3. Baseline numbers (run C)

All latencies in ms (median / p95). Contract-level error rate was **0** in every
scenario (k6 `http_req_failed.rate = 0`, all business checks = 1.0, all process
exit codes = 0).

| Scenario | Profile | reqs (rps) | Key operations (med / p95) |
| --- | --- | --- | --- |
| S8 mixed steady state | 10 VUs × 90 s (40/35/25 create/list/refund) | 2 310 (25.6) | create 78.1/172.9 · list 149.6/584.5 · refund 104.3/219.3 |
| S1 auth & session | 5 VUs × 60 s (fresh accounts + AR-3 probe) | 455 (7.3) | register 836.4/1254.4 · login 773.3/1064.9 · 79 account-scope 429s (AR-3, expected) |
| S2 payments write | 10 VUs × 60 s (60% plain / 40% idempotent) | 2 183 (36.1) | create 52.5/132.2 · 1 548 created · 635 idempotent replays |
| S3 payments read | 10 VUs × 60 s (50% list / 50% get, **over S2 backlog**) | 38 (0.6) | **list 58 769/59 430 (max 59 503) — catch-up convoy, see §6** · get 50.2/159.1 |
| S4 customers search | 10 VUs × 60 s (60% search / 40% list) | 4 578 (76.1) | search 29.1/82.1 · list 16.6/45.1 |
| S5 webhook plane | 5 VUs × 60 s (4:1 primary flood, per-project sampling) | 1 648 (27.4) | create primary 72.7/120.4 · create secondary 62.4/113.1 · list primary 227.3/433.8 · list secondary 81.6/169.5 |
| S6 unmatched 404 | 10 VUs × 60 s (nonexistent paths) | 10 267 (171.0) | unmatched 3.7/19.7 · 10 267/10 267 without rate-limit headers (designed) |
| S7 dashboard session | 10 VUs × 90 s (session-mode read/write mix) | 802 (13.2) | read 11.0/24.4 · create 41.1/61.8 · 24 environment switches |

Worker plane (run C, 5 s in-scenario sampler):

| Signal | Value |
| --- | --- |
| Settles | before-S5 0.9 s · after-S5 58.3 s · final 4.4 s |
| S2 → S3 backlog | S2 exits with 1 341 open payments; S3 drains 1 291 → 40 during the scenario (sweep-paced ≈ 18/s) |
| S5 fairness (F2a) | per-project oldest-pending age tracks within 15–25 s across the 4:1 flood (primary 375→430 s vs secondary 355→410 s) — **no starvation** (P-05) |
| Request logs | 22 302 rows / 10.4 MB at run end (≈ 470 B/row); **frozen for the whole S3 window** (inserts stalled behind the same DB convoy, flushed in S4 — P-11) |
| Deliveries | pending 6 500 / delivered 14 068 / failed 793 (fail-path ladder terminals); receiver totals 38 662 (14 068 ok, 24 594 fail-path retries) |
| Queue | advancement/delivery queue drained to wait=0 at settle-final; delayed ≈ 7 775 (backoff ladder) |

## 4. Three-run comparison (band input)

| Scenario / operation | A med/p95 | B med/p95 | C med/p95 |
| --- | --- | --- | --- |
| S1 register | 651.5/1116.0 | 643.5/925.2 | 836.4/1254.4 |
| S1 login | 627.0/955.8 | 626.8/934.2 | 773.3/1064.9 |
| S2 create | 41.0/87.8 | 35.1/77.8 | 52.5/132.2 |
| S3 list | 13.7/172.5 (**max 50.3 s**) | 13.0/1688.0 (**max 54.0 s**) | 58 769/59 430 (**max 59.5 s**) |
| S3 get | 9.9/24.2 | 10.3/29.9 | 50.2/159.1 |
| S4 search | 22.2/61.3 | 27.7/101.8 | 29.1/82.1 |
| S5 list primary | 167.4/330.7 | 214.5/392.2 | 227.3/433.8 |
| S5 list secondary | 71.6/122.1 | 83.2/177.2 | 81.6/169.5 |
| S6 unmatched | 2.3/10.5 | 2.3/8.0 | 3.7/19.7 |
| S7 read | 10.8/21.8 | 10.6/22.3 | 11.0/24.4 |
| S8 list | 107.2/382.8 | 110.9/414.7 | 149.6/584.5 |
| S3 throughput | 12.9 rps | 6.7 rps | 0.6 rps |

## 5. Variance band and guardrail (D3(a))

Standing guardrail for regression re-runs on this machine class:

1. **Medians and throughput** of S1, S2, S4, S5, S6, S7, S8 stay within
   **±40 % / ×0.6–1.4** of the run-C values above (empirical envelope of
   A/B/C; S8 list and S1/S2/C-medians absorb the loaded-machine effect of
   run C).
2. **Contract-level error rate ≈ 0** (k6 fail rate 0, business checks 1.0,
   exit code 0) — the primary functional guardrail.
3. **Worker-plane settles** before S5 / final stay in the low single-digit
   seconds; after-S5 is backlog-dependent (0.9–58.3 s across A/B/C) and is
   informational.
4. **S3 list under catch-up backlog is NOT band-guardable** (§6): compare it
   against the P-01 exit criteria, not against a band.

Deviations are explained in the rerun record; a deviation that cannot be
explained is investigated before it is waved through.

## 6. Known structural observation — S3 catch-up convoy (P-01)

S3 deliberately runs with no settle after S2, so list requests exercise
read-time catch-up (`catchUpEnvironment`, Phase 7 D2) over a ~1.3 k due-payment
backlog while the queue-driven sweep drains the same rows. Every one of the
three runs shows list **maxima of 50.3–59.5 s** (lock-wait convoy between
catch-up CAS updates and sweep transactions on the same rows); run C was
unlucky enough that the convoy ate VU time wholesale (38 requests, p95 ≈ 59 s,
throughput 0.6 rps). Steady-state reads are unaffected (S3 get med 10–50 ms;
S7 read med ≈ 11 ms; S5 list med 82–227 ms).

Disposition: accepted-with-exit-criteria + referred proposal (findings P-01,
ADR-0039). The remedy (page-scoped/capped catch-up) changes Phase 7 D2 pinned
behavior and is therefore a product-authority decision, not a silent fix.

## 7. Optimization record (AC4/AC5)

One product change shipped in this phase (findings P-07): the dashboard
payments background poll stands down after "Load more" instead of collapsing
appended pages. Before/after evidence is the web unit suite:
`payments-pages.spec.tsx` — new regression test green, existing D2 poll test
untouched and green (11/11). No API, configuration, or contract semantics
changed; no API-plane before/after numbers apply.

## 8. Methodology notes

- **k6 summary export quirk:** the exported `http_req_failed.fails` count is
  misleading (it showed non-zero "fails" with `rate = 0` in every run). Pass/fail
  authority = `http_req_failed.rate`, business `checks` rate, and process exit
  code.
- **Sampler history:** runs A/B lack in-scenario worker samples (the runner used
  `spawnSync`, starving the sampler); fixed to async spawn before run C. Receiver
  `pathKey` crash and the fairness-query SQL quoting bug were fixed before runs
  A–C (run numbering restarted at A after the fixes).
- **Run C as baseline:** chosen for complete evidence (in-scenario samples,
  fairness series, request-log lag). Its S3 collapse is recorded, not hidden
  (§6); its slightly higher S1/S2/S8 medians reflect a loaded machine and are
  absorbed by the band.
