---
description: Show the stored final output for a finished Codex job in this repository
argument-hint: '[job-id] [--full|--max-chars <n>]'
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" result "$ARGUMENTS"`

Present the command output to the user exactly. Do not summarize or condense it. Preserve all details including:
- Job ID and status
- The result payload, including verdict, summary, findings, details, artifacts, and next steps
- File paths and line numbers exactly as reported
- Any error messages or parse errors
- Follow-up commands such as `/codex:status <id>` and `/codex:review`

Output is capped at 8000 chars by default to protect the caller's context. If the output reports truncation and the missing detail matters, rerun with `--full` (or a higher `--max-chars`) — or read the referenced job log selectively instead.
