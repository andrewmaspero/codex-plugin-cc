---
description: Start a follow-up Codex turn on a specific existing thread with a corrective or continuation prompt
argument-hint: '<thread-id> [--background] [--write|--full|--sandbox <mode>] [--worktree|--worktree-name <name>] [--goal <objective>] [--model <model|spark>] [--effort <effort>] [prompt]'
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" continue "$ARGUMENTS"`

Present the command output exactly.

- Use this when a job already finished and needs a correction or follow-up on the same thread context; use `/codex:steer` only while a turn is still running.
- Default execution is foreground (blocking). Append `--background` unless the follow-up is clearly tiny or the user asked to wait, then monitor via `/codex:status <job-id>` and fetch output with `/codex:result <job-id>`.
- `--goal <objective>` / `--goal-budget <tokens>` set a persistent thread goal for the follow-up; see `/codex:goal` for how to write one.
