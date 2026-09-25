---
description: Start a follow-up Codex turn on a specific existing thread with a corrective or continuation prompt
argument-hint: '<thread-id> [--background] [--write|--full|--sandbox <mode>] [--worktree|--worktree-name <name>] [--goal <objective>] [--model <model|astra|sol|luna|sol-5.6|terra|luna-5.6|spark>] [--effort <none|minimal|low|medium|high>] [prompt]'
allowed-tools: Bash(node:*)
---

The raw arguments are:

$ARGUMENTS

Run the continue command with a single `Bash` tool call.

- If the follow-up prompt has no shell metacharacters, run it directly:
  `node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mts" continue $ARGUMENTS`
- If the prompt contains backticks, quotes, or `$` (common — follow-ups cite
  `code` and paths), do NOT inline it into a `!`-prefixed command. Feed the prompt
  over stdin via a single-quoted heredoc and pass `--prompt-stdin`, with only the
  `<thread-id>` and any flags as argv tokens:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mts" continue <THREAD_ID> --background --prompt-stdin <<'CODEX_CONTINUE_EOF'
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
- Without `--model`, the follow-up keeps the thread's model. Aliases: `astra` = `gpt-6-astra` (frontier, expensive; use sparingly; effort at most `medium`), `sol` = `gpt-6-sol` (default workhorse for coding and reviews), `luna` = `gpt-6-luna` (near-free, fast; strong for bulk, vision, research, and strictly specified coding; supports effort `none`). Legacy: `sol-5.6` = `gpt-5.6-sol`, `terra` = `gpt-5.6-terra`, `luna-5.6` = `gpt-5.6-luna`, `spark` = `gpt-5.3-codex-spark`.
- Accepted efforts are `none`, `minimal`, `low`, `medium`, and `high`; the general policy ceiling is `high`, while `gpt-6-astra` accepts only `low` or `medium` and receives `medium` when no effort is given.
