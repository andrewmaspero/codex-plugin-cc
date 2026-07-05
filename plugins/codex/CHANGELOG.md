# Changelog

## 1.3.1 (fork)

Production-readiness gate fixes (second fresh-context review):

- codex-cli-runtime no longer injects `--write` by default, which silently
  downgraded workspaces configured with `setup --sandbox full`; the rescue
  path now defers to the workspace sandbox default
- Session-end job cleanup uses the state lock (no lost updates in
  multi-session workspaces) and lock release is token-checked so a stolen
  stale lock can never delete another writer's live lock
- Worktree jobs reap their per-worktree broker at job end, cancel, and
  session end (no leaked broker/app-server processes)
- Adversarial reviews record their runtime endpoint, so they steer reliably
  even when they land on a dedicated broker
- `--goal` on a Codex CLI without thread-goal support fails with an
  actionable message instead of a raw protocol error
- Control connections time out instead of hanging on a wedged runtime
  (5s broker initialize, 30s direct app-server start)
- `/codex:alerts` surfaces unreachable goal checks instead of implying all
  clear; `result <running-job>` says the job is still running instead of
  "no job found"; argument-hints synced with real flags

## 1.3.0 (fork)

- Parallel jobs in one workspace are now fully steerable: when the shared
  broker is busy streaming another job, a new background job gets its own
  dedicated broker instead of an unreachable in-process app-server. The
  job records its runtime endpoint; steer, goal, and cancel target it
  directly, and the dedicated broker is shut down when the job finishes,
  is cancelled, or the session ends.
- state.json updates are serialized with a lock file (stale-lock recovery,
  bounded wait) and all state/job writes are atomic (temp file + rename),
  eliminating lost updates between concurrent workers and control commands.

## 1.2.0 (fork)

- Native thread goals: `/codex:goal set|show|clear` over app-server
  `thread/goal/*`, `--goal`/`--goal-budget` on rescue and continue set the
  goal before the first turn, and blocked/usage-limited/budget-limited goal
  statuses surface automatically in `/codex:alerts`. The goal command doc
  includes guidance on writing checkable goal objectives.
- The control plane is now model-invocable: removed
  `disable-model-invocation` from status, result, cancel, steer, continue,
  and all viewers so an orchestrator agent can poll, steer, and fetch its own
  background jobs.
- Argument fidelity: a bare `--` now switches the slash-command tokenizer to
  verbatim passthrough, so steer corrections and goal objectives keep
  apostrophes, quotes, and backslashes; pagination cursors are rendered
  pre-quoted and survive the `$ARGUMENTS` path (tested end to end).
- `/codex:result` caps rendered output at 8000 chars by default
  (`--full`/`--max-chars` to override) so job results cannot flood the
  caller's context.
- `/codex:artifacts` lists a job's `.codex-artifacts/<job-id>/` evidence
  directory (screenshot/report convention for computer-use verification).
- Alert quality: failed-job alerts expire after 30 minutes, command-failure
  counting is windowed to recent commands, stall detection is
  timestamp-anchored with a softer suggestion during long-running commands
  (default threshold 300s), and dead workers are flagged as `orphaned`.
- Steering hardening: session-scoped no-argument selection, one bounded retry
  on transient broker-busy, a `Steered:` audit line in the job log with
  `lastSteerAt` on the job, and an honest failure message when a running
  job's turn is unreachable (parallel same-workspace jobs).
- `/codex:items` accepts `--cursor` and turn-id prefixes; viewers print
  shortened turn ids.

## 1.1.0 (fork)

- Add `turn/steer` support: `/codex:steer <job-id> -- <correction>` steers the active
  turn of a running background job; the shared broker now lets `turn/steer` through
  during an active stream, same as `turn/interrupt`.
- Add token-efficient thread viewers: `/codex:threads`, `/codex:thread`, `/codex:turns`,
  `/codex:items` with pagination, type filters, and hard output budgets, backed by
  `thread/list`, `thread/read`, and experimental `thread/turns/list` (with a
  `thread/read` fallback for older Codex CLIs).
- Add `/codex:tail` (bounded job log tail) and `/codex:alerts` (stall, repeated command
  failure, error, and long-runtime drift detection with suggested actions).
- Add `/codex:continue <thread-id>` for explicit follow-up turns on a known thread.
- Enable the `experimentalApi` capability on app-server connections to unlock the
  experimental read APIs.

## 1.0.0

- Initial version of the Codex plugin for Claude Code
