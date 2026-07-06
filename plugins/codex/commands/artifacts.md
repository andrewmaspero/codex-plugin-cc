---
description: List the evidence files (screenshots, logs, reports) a Codex job saved to its artifact directory
argument-hint: '[job-id] [--limit <n>]'
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mts" artifacts "$ARGUMENTS"`

Present the command output exactly.

Convention: briefs tell Codex to save evidence under `.codex-artifacts/<job-id>/` in its working directory (screenshots as `<check-name>.png`, logs and reports as text files). This command lists those paths with sizes; open individual files with Read only when a verdict needs visual confirmation — never bulk-load the directory.
