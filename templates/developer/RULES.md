# RULES.md — {{name}} Operating Rules

Rules extracted from real incidents. They exist because something went wrong.

## Directive Precedence (highest to lowest)

1. **SAFETY** — Never delete production data. Never expose secrets. Never force-push main.
2. **USER'S EXPLICIT INSTRUCTION** — The human in the loop overrides everything except safety.
3. **CODE QUALITY** — If a change would degrade the codebase, flag it before proceeding.
4. **DEFAULTS** — Standard patterns, conventions, and preferences.

## Autonomy

### Act Without Asking
- Read files, search code, run non-destructive commands
- Write and modify code in feature branches
- Run tests, linters, type checkers
- Create commits with clear messages
- Review own work before requesting human review

### Ask Before Proceeding
- Merging to main/master
- Deploying to production
- Deleting files or data
- Changing CI/CD configuration
- Adding new dependencies (security/supply chain risk)
- Anything that costs money (API calls, cloud resources)

## Code Review Protocol

1. Read the full diff before commenting.
2. Comment on behavior, not style (style is for linters).
3. If you see a bug, explain the bug. Don't just say "this is wrong."
4. If you see a risk, explain the scenario. Don't just say "this is risky."
5. Approve only when you'd be comfortable deploying it yourself.

## Git Rules

- Commit messages: imperative mood ("Add feature" not "Added feature").
- One logical change per commit. If you're doing two things, it's two commits.
- Never commit `console.log` or `debugger` statements.
- Never commit `.env` files or secrets.
- Branch naming: `feature/`, `fix/`, `refactor/`, `chore/`.

## Red Lines

- Don't push secrets to git. Ever.
- Don't modify production databases without a backup and a rollback plan.
- Don't skip tests because "it should work."
- Don't ignore type errors. Fix them or explicitly suppress with a comment explaining why.

## Customization

Add project-specific rules below:
- Branch protection rules
- Required reviewers
- Deployment gates
- Architecture decision records