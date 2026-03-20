# Agent Policy — Git & Code Changes

## Objective

Ensure that every code modification produced by the agent results in:
- clean
- atomic
- reversible
- meaningful Git history

---

## Core Principle

One commit = one intention

---

## Commit Rules

### MUST

- Use Angular / Conventional Commit format:
  type(scope): subject

- Commit only when:
  - the requested change is fully implemented
  - the change is coherent and self-contained

- Stage only:
  - relevant files
  - relevant hunks

- Prefer partial staging over committing unrelated changes

---

### MUST NOT

- Commit multiple unrelated changes in a single commit
- Commit debug code (console.log, print, etc.)
- Commit secrets (.env, API keys, tokens)
- Commit build artifacts (dist/, build/, coverage/)
- Commit WIP or incomplete changes

---

## Commit Types

- feat: new functionality
- fix: bug fix
- refactor: code change without behavior change
- docs: documentation only
- test: tests only
- chore: maintenance / infra
- perf: performance improvement

---

## Commit Message Rules

- English only
- Imperative mood (e.g., "add", "fix", "update")
- No final period
- Max ~72 characters
- Must reflect actual change

---

## Atomicity Rules

### Acceptable

- Feature + minimal required wiring
- Fix + associated test
- Refactor limited to feature scope

### Not acceptable

- Feature + unrelated refactor
- Fix + formatting across whole repo
- Mixed backend + frontend unrelated changes

---

## Partial Staging

When a file contains multiple intentions:

- Stage only relevant hunks
- Leave unrelated changes unstaged

If isolation is unsafe:
- DO NOT COMMIT
- Explain why

---

## Safety Rules

Before commit, the agent must check:

- No secrets in diff
- No debug leftovers
- No unintended files
- Diff matches commit message

---

## Checks

If configured:

- Run lint
- Run tests

If any check fails:
- DO NOT COMMIT
- Return error with reason

---

## Refusal Conditions

The agent MUST refuse to commit if:

- Changes are not isolatable
- Tests fail
- Diff is empty
- Commit would mix multiple intentions

---

## Examples

### Good

feat(results): add CSV export button

fix(api): handle missing analysis timestamp

refactor(front): split results page components

---

### Bad

misc changes

update stuff

fix + refactor + cleanup

---

## Advanced Behavior

The agent should:

- Prefer multiple small commits over one large commit
- Keep history readable without context
- Ensure each commit can be reverted independently

---

## Default Behavior

After each user request:

- Apply changes
- Evaluate commitability
- Commit if safe
- Otherwise explain why not
