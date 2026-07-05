---
description: Steer the active turn of a running background Codex job with a short corrective instruction
argument-hint: '<job-id> -- <short corrective instruction>'
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" steer "$ARGUMENTS"`

Present the command output exactly. Do not add commentary.

If steering failed because there is no active turn, suggest the follow-up the output recommends (`/codex:result`, `/codex:continue`, or `/codex:cancel` plus relaunch) and stop.
