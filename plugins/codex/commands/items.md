---
description: List compact thread items (messages, commands, file changes) with type filters and a hard output budget
argument-hint: '<thread-id> [--turn <turn-id>] [--type <userMessage,agentMessage,commandExecution,fileChange,...>] [--limit <n>] [--cursor <cursor>] [--budget <chars>]'
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mts" items "$ARGUMENTS"`

Present the command output exactly. If the output reports truncation, narrow with `--turn` or `--type` before raising `--budget`.
