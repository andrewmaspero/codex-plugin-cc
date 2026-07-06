---
description: Set, show, or clear a persistent goal on a Codex job or thread to keep long-running loops anchored
argument-hint: '<set|show|clear> [job-id|thread-id] [--budget <tokens>] [--status <active|paused|blocked|complete>] [-- <objective>]'
allowed-tools: Bash(node:*)
---

The raw arguments are:

$ARGUMENTS

Run the goal command with a single `Bash` tool call.

- For `goal show` / `goal clear`, or `goal set` whose objective has no shell
  metacharacters, run it directly:
  `node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mts" goal $ARGUMENTS`
- For `goal set` whose objective contains backticks, quotes, or `$` (common —
  acceptance criteria often cite `commands` and paths), do NOT inline the objective
  into a `!`-prefixed command (it expands inside a double-quoted backtick command
  and breaks on the first backtick or unbalanced quote). Feed the objective over
  stdin via a single-quoted heredoc and pass `--objective-stdin`, with only the
  `set` action and optional `<job-id|thread-id>` as argv tokens:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mts" goal set <REF> --objective-stdin <<'CODEX_GOAL_EOF'
<paste the objective text here verbatim (everything after the `--`)>
CODEX_GOAL_EOF
```

The single-quoted delimiter disables all shell expansion, so the objective passes
through byte for byte. Add `--budget <tokens>` / `--status <status>` as normal flags.

Present the command output exactly.

What a goal does: Codex persists the goal on the thread (native `thread/goal` support) and keeps it in front of the model across turns, tracking tokens and time spent against it. The goal survives steering, follow-up turns, and context compaction — it is the anchor for long-running loops (UI verification sweeps, large restructures, migration passes) where per-turn prompts drift.

Goals versus steering: the goal is the destination; steering is a course correction. Set the goal once at launch (`--goal` on `/codex:rescue` or `/codex:continue`) or with `goal set`; steer with short deltas as the run unfolds. If a correction changes what "done" means, update the goal, not just the steer.

Writing a good goal objective (max 4000 chars):

1. One-sentence outcome first: what must be true when the goal is complete.
2. Checkable acceptance criteria as a list — each one verifiable by Codex itself (a command to run, a page to screenshot, a state to assert). Vague goals ("make sure the UI is good") produce vague checking; concrete criteria ("every page in src/pages renders at 375px and 1440px with no horizontal scroll, no console errors, screenshots saved to .codex-artifacts/<job-id>/") force real verification.
3. The verification loop expectation: "after every change, re-run <command/check> before moving on."
4. Stop conditions: when to declare the goal blocked instead of thrashing (e.g. "if the same test fails after 3 distinct fixes, set the goal status to blocked and summarize the blocker").
5. Optionally a token budget (`--budget`) so runaway loops surface as `budgetLimited` instead of burning quietly.

If the objective needs more than 4000 chars, write the details to a file and set the objective to: "Read the goal file at <path> before continuing. <one-line outcome>."

A `blocked`, `usageLimited`, or `budgetLimited` goal status appears in `/codex:alerts` automatically — check the goal with `goal show <job-id>` when an alert fires, then steer, raise the budget, or replan.
