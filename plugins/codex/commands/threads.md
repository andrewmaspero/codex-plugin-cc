---
description: List recent Codex threads for this workspace, one compact line per thread
argument-hint: '[--limit <n>] [--cursor <cursor>] [--search <term>] [--all]'
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mts" threads "$ARGUMENTS"`

Present the command output exactly. It is already compact; do not expand it, fetch thread contents, or add commentary.
