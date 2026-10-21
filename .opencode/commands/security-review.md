---
description: Perform a focused security audit of the current BrinnPay changes.
agent: security
---

---

Perform a security review of:

$ARGUMENTS

Read:

- AGENTS.md
- .ai/SPEC.md
- relevant phase specification
- current diff
- affected implementation

Evaluate:

- authentication
- authorization
- tenant isolation
- IDOR
- input validation
- injection
- secrets
- API keys
- cryptography
- rate limiting
- sensitive logging
- SSRF/XSS/CSRF where applicable
- abuse scenarios

Do not modify files.

Report concrete findings with severity, evidence, impact, and mitigation.

Finish with:

PASS
PASS WITH WARNINGS
or
FAIL
