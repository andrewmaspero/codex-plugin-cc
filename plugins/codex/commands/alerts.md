---
description: Check Codex jobs for drift - stalls, repeated command failures, errors, long runtimes, orphaned workers, goal drift - as compact alerts
argument-hint: '[job-id] [--stall-seconds <n>] [--no-goals]'
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" alerts "$ARGUMENTS"`

Present the command output exactly. Each alert already includes evidence and a suggested action; act on the suggestion (wait, `/codex:steer`, `/codex:cancel` and relaunch, or `/codex:continue`) rather than fetching raw logs.
