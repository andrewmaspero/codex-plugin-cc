---
description: Steer the active turn of a running background Codex job with a short corrective instruction
argument-hint: '<job-id> -- <short corrective instruction>'
allowed-tools: Bash(node:*)
---

Steer a running Codex job. The raw arguments are:

$ARGUMENTS

Run the steer with a single `Bash` tool call. The steer message often contains
backticks, quotes, `$`, or other shell metacharacters, so it must NOT be inlined
into a `!`-prefixed command string (that path expands `$ARGUMENTS` inside a
double-quoted backtick command and breaks on the first backtick or unbalanced
quote). Instead feed the message to the companion over stdin via a single-quoted
heredoc, so the shell performs no expansion on it, and pass ONLY the job id as an
argv token:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mts" steer <JOB_ID> --message-stdin <<'CODEX_STEER_EOF'
<paste the corrective message here verbatim (everything after the `--`)>
CODEX_STEER_EOF
```

Split `$ARGUMENTS` yourself: the first whitespace-delimited token before `--` is
`<JOB_ID>`; everything after the `--` separator is the message body that goes
inside the heredoc. The single-quoted delimiter (`<<'CODEX_STEER_EOF'`) disables
every form of shell expansion, so backticks, `$`, and quotes pass through byte for
byte. If the user omitted a job id (bare `--` first), drop `<JOB_ID>` and the
companion auto-selects this session's active job.

Present the command output exactly. Do not add commentary.

If steering failed because there is no active turn, suggest the follow-up the output recommends (`/codex:result`, `/codex:continue`, or `/codex:cancel` plus relaunch) and stop.
