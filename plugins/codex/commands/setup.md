---
description: Check whether the local Codex CLI is ready, toggle the stop-time review gate, and set the default sandbox trust level
argument-hint: '[--enable-review-gate|--disable-review-gate] [--sandbox <read-only|write|full|clear>]'
allowed-tools: Bash(node:*), Bash(npm:*), AskUserQuestion
---

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mts" setup --json $ARGUMENTS
```

If the result says Codex is unavailable and npm is available:
- Use `AskUserQuestion` exactly once to ask whether Claude should install Codex now.
- Put the install option first and suffix it with `(Recommended)`.
- Use these two options:
  - `Install Codex (Recommended)`
  - `Skip for now`
- If the user chooses install, run:

```bash
npm install -g @openai/codex
```

- Then rerun:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mts" setup --json $ARGUMENTS
```

If Codex is already installed or npm is unavailable:
- Do not ask about installation.

Sandbox trust level:
- `--sandbox full` (alias `danger-full-access`) makes every rescue/continue job in this workspace run with full permissions and no sandbox. Use it when the user says they trust Codex and do not want sandboxing.
- `--sandbox write` defaults jobs to workspace-write; `--sandbox read-only` or `--sandbox clear` restores the conservative default.
- Per-call flags (`--full`, `--write`, `--sandbox <mode>`) still override the workspace default.

Output rules:
- Present the final setup output to the user.
- If installation was skipped, present the original setup output.
- If Codex is installed but not authenticated, preserve the guidance to run `!codex login`.
