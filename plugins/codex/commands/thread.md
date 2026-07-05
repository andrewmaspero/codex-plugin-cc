---
description: Show a compact header for one Codex thread (no transcript dump)
argument-hint: '<thread-id>'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" thread "$ARGUMENTS"`

Present the command output exactly. Never fetch or render the full thread transcript; use `/codex:turns` and `/codex:items` for bounded slices.
