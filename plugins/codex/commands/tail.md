---
description: Show the last N progress log lines for a Codex job (bounded, local, no server call)
argument-hint: '[job-id] [--lines <n>]'
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mts" tail "$ARGUMENTS"`

Present the command output exactly. Do not re-read the underlying log file directly; this command already bounds the output.
