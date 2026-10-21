---
description: Prepare a Git Flow pull request from the current branch using repository conventions.
agent: release
---

---

Prepare the current branch for a pull request.

Before doing anything:

- Run `git status`.
- Inspect the current branch with `git branch --show-current`.
- Inspect recent commits with `git log --oneline -15`.
- Inspect the diff against the appropriate base branch.
- Determine the correct Git Flow target branch.

Git Flow rules for BrinnPay:

- feature/\* -> develop
- fix/\* -> develop
- refactor/\* -> develop
- security/\* -> develop
- chore/\* -> develop
- release/\* -> main
- hotfix/\* -> main

Do not change the branch or push unless explicitly requested.

Validation:

- Ensure the working tree is clean.
- Review all commits included in the PR.
- Confirm commits follow Conventional Commits.
- Identify accidental unrelated changes.
- Run the checks required by the current project phase.
- Do not create a PR if required validation is failing unless explicitly requested.

PR title:

- Use a concise Conventional Commit-style title.
- Prefer:
  `<type>(<scope>): <description>`
- The title should describe the overall purpose of the PR, not enumerate individual commits.

PR description should contain:

## Summary

Brief explanation of what changed.

## Changes

Important implementation changes grouped by concern.

## Validation

Commands/checks that were run and their results.

## Security

Security implications or explicitly state that no security-sensitive behavior changed.

## Notes

Important architectural decisions, trade-offs, limitations, or follow-up work.

## Checklist

- [ ] Scope matches the current phase
- [ ] Tests/checks pass
- [ ] No unrelated changes
- [ ] Security implications reviewed
- [ ] Documentation updated when necessary

The PR should target `develop` unless this is a release/hotfix branch.

If GitHub CLI is available:

- You may prepare the `gh pr create` command.
- Do not execute it automatically unless explicitly requested.

Do not push automatically.

The final response should provide:

1. Target branch
2. Suggested PR title
3. Complete PR body
4. Validation results
5. Suggested `gh pr create` command
