---
description: Show a compact header for one Codex thread (no transcript dump)
argument-hint: '<thread-id>'
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mts" thread "$ARGUMENTS"`

Present the command output exactly. Never fetch or render the full thread transcript; use `/codex:turns` and `/codex:items` for bounded slices.
