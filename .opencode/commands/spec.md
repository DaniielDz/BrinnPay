---
description: Create or review the specification for a BrinnPay phase.
agent: architect
---

---

Work on the BrinnPay specification for: $ARGUMENTS

Read:

- AGENTS.md
- .ai/SPEC.md
- ROADMAP.md
- the relevant existing phase specification, if present
- relevant existing source code when necessary

Determine the requested phase from the argument.

If the phase specification does not exist:

- Create `.ai/phases/phase-XX-<name>.md`.
- Use ROADMAP.md as the initial scope.
- Expand the roadmap item into a complete implementation-ready specification.

If the phase specification already exists:

- Review it against the master specification, roadmap, architecture, and existing code.
- Identify missing requirements, inconsistencies, ambiguities, or outdated decisions.
- Update the phase specification when necessary.

The specification must define:

- objective
- scope
- domain rules
- API behavior
- data requirements
- security requirements
- acceptance criteria
- implementation considerations
- testing requirements
- definition of done
- explicit out-of-scope items

Do not implement application code.

Keep the specification focused on WHAT the system must do, not detailed file-by-file implementation instructions.

Do not invent business requirements.

If an important requirement is ambiguous, identify it explicitly and request a decision rather than silently choosing a behavior.

After creating or updating the specification, report:

1. Specification path
2. Summary
3. Key decisions
4. Open questions
5. Acceptance criteria
6. Recommended next step
