---
description: Run and analyze BrinnPay tests for the specified area.
agent: tester
---

---

Test the following BrinnPay area:

$ARGUMENTS

Read:

- AGENTS.md
- relevant phase specification
- existing tests
- affected implementation

Determine the appropriate unit, integration, and e2e coverage.

Focus on:

- acceptance criteria
- edge cases
- validation
- authorization
- tenant isolation
- concurrency
- state transitions
- idempotency
- retries
- regressions

Run the relevant tests.

If failures reveal implementation problems, report them clearly.

Do not weaken production behavior just to make tests pass.
