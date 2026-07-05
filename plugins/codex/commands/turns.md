---
description: List a Codex thread's turns newest-first with one-line summaries and pagination
argument-hint: '<thread-id> [--limit <n>] [--cursor <cursor>]'
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" turns "$ARGUMENTS"`

Present the command output exactly. If more detail on one turn is needed, use `/codex:items <thread-id> --turn <turn-id>` instead of raising the limit.
