# Claude Code Instructions

## Git Policy

Follow all rules defined in `tools/ai/agent_policy.md`:
- One commit = one intention (atomic, self-contained, reversible)
- Angular/Conventional Commit format: `type(scope): subject`
- Stage only relevant files and hunks
- Refuse to commit if changes mix multiple intentions
- **NEVER** add `Co-Authored-By` or any Claude/AI signature in commit messages

Commit schema: `tools/ai/git_atomic_commit.yaml`
Staging/check helpers: `tools/ai/git_helpers.sh`

## Build

```bash
go build ./...
```
