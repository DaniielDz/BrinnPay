---
description: Prepare and validate a BrinnPay release.
agent: release
---

---

Prepare the BrinnPay release for:

$ARGUMENTS

Check:

- git status
- current branch
- repository state
- tests
- lint
- typecheck
- build
- CI status when available
- documentation
- version
- release notes
- known security issues

Do not bypass failing checks.

Do not create or publish a release automatically.

Return:

1. Release readiness
2. Blocking issues
3. Validation results
4. Recommended version
5. Remaining actions
