---
description: Cancel an active background Codex job in this repository
argument-hint: '[job-id]'
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mts" cancel "$ARGUMENTS"`
