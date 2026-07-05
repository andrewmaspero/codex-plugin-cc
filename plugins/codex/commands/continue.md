---
description: Start a follow-up Codex turn on a specific existing thread with a corrective or continuation prompt
argument-hint: '<thread-id> [--background] [--write] [--model <model|spark>] [--effort <effort>] [prompt]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" continue "$ARGUMENTS"`

Present the command output exactly.

- Use this when a job already finished and needs a correction or follow-up on the same thread context; use `/codex:steer` only while a turn is still running.
- With `--background`, monitor via `/codex:status <job-id>` and fetch output with `/codex:result <job-id>`.
