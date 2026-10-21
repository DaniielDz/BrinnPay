---
description: Create one or more Conventional Commits for the current changes using Git best practices.
agent: release
---

---

Review the current Git working tree and determine the correct commit strategy.

Before committing:

- Run `git status`.
- Inspect the full diff with `git diff`.
- Inspect staged changes with `git diff --cached` when applicable.
- Review recent commits with `git log --oneline -10`.
- Understand whether the current changes represent one logical unit or multiple independent units.

Commit strategy:

- Prefer a single commit when all changes belong to one coherent logical change.
- Split changes into multiple commits when they represent independent logical units, separate concerns, or would be useful to revert independently.
- Do not create commits merely because files are different.
- Do not split tightly coupled changes that must remain together.
- Avoid unrelated cleanup or formatting changes.
- Prefer focused, reviewable, buildable commits.
- Each commit should leave the repository in a valid state whenever practical.

Use Conventional Commits:

<type>[optional scope]: <description>

Allowed types include:

- feat
- fix
- refactor
- perf
- test
- docs
- chore
- build
- ci
- security
- revert

Rules:

- Use imperative wording.
- Keep the subject concise.
- Do not end the subject with a period.
- Use a scope when it improves clarity.
- Add a body only when the reason or important context is not obvious from the subject.
- Use BREAKING CHANGE only when applicable.
- Never use `git commit --no-verify`.
- Never amend an existing commit unless explicitly requested.
- Never force-push.

Before creating commits, identify the proposed commit plan.

Then:

1. Stage the appropriate files for the first logical commit.
2. Create the commit.
3. Continue with additional commits if the changes were intentionally split.
4. Verify `git status`.
5. Show the resulting commit list.

Do not push automatically.

If the working tree contains ambiguous or unrelated changes, report them and avoid committing unrelated work.

The final response should include:

- commit strategy
- commits created
- files included in each commit
- remaining uncommitted changes, if any
- recommended next step
