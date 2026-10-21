# ADR-0013: BullMQ Integration Timing — Phase 10, Not Phase 2

- **Status:** Accepted
- **Date:** 2026-09-17
- **Phase:** 2
- **Scope:** Queue infrastructure (`apps/api`, Redis).

## Context

The architecture mandates Redis + BullMQ for queues. Phase 2 establishes Redis connectivity as
part of the foundation, but no business events exist until Phases 6–10. Wiring BullMQ producers,
consumers, and queues now would build infrastructure with no workload against it.

## Decision

- Phase 2 provisions Redis and verifies connectivity via the readiness check; no BullMQ wiring.
- BullMQ dependencies, queues, and workers are introduced in Phase 10, when business events (e.g.,
  webhook/event processing) first exist.
- Phase 2 readiness considers Redis reachable as the dependency contract.

## Consequences

- Redis infra is proven early while avoiding speculative queue/worker code.
- Phase 10 introduces BullMQ against real event requirements, so queue design matches actual
  workloads.
- The foundation already verifies the Redis connection, de-risking Phase 10 integration.