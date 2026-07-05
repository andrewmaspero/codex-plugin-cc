---
description: Start a follow-up Codex turn on a specific existing thread with a corrective or continuation prompt
argument-hint: '<thread-id> [--background] [--write|--full|--sandbox <mode>] [--worktree|--worktree-name <name>] [--goal <objective>] [--model <model|spark>] [--effort <effort>] [prompt]'
allowed-tools: Bash(node:*)
---

The raw arguments are:

$ARGUMENTS

Run the continue command with a single `Bash` tool call.

- If the follow-up prompt has no shell metacharacters, run it directly:
  `node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" continue $ARGUMENTS`
- If the prompt contains backticks, quotes, or `$` (common — follow-ups cite
  `code` and paths), do NOT inline it into a `!`-prefixed command. Feed the prompt
  over stdin via a single-quoted heredoc and pass `--prompt-stdin`, with only the
  `<thread-id>` and any flags as argv tokens:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" continue <THREAD_ID> --background --prompt-stdin <<'CODEX_CONTINUE_EOF'
<paste the follow-up prompt here verbatim>
CODEX_CONTINUE_EOF
```

The single-quoted delimiter disables all shell expansion, so the prompt passes
through byte for byte. Keep `--background`, `--full`/`--write`/`--sandbox`,
`--worktree`, `--goal`, `--model`, `--effort` as normal flags.

Present the command output exactly.

- Use this when a job already finished and needs a correction or follow-up on the same thread context; use `/codex:steer` only while a turn is still running.
- Default execution is foreground (blocking). Append `--background` unless the follow-up is clearly tiny or the user asked to wait, then monitor via `/codex:status <job-id>` and fetch output with `/codex:result <job-id>`.
- `--goal <objective>` / `--goal-budget <tokens>` set a persistent thread goal for the follow-up; see `/codex:goal` for how to write one.
