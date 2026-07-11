# Changelog

## 1.7.0 (fork)

GPT-5.6 model family support.

- Added model aliases `sol` → `gpt-5.6-sol`, `terra` → `gpt-5.6-terra`, and
  `luna` → `gpt-5.6-luna` alongside the legacy `spark` alias.
- Capped `--effort` at `high` by policy: accepted values are now `none`,
  `minimal`, `low`, `medium`, `high` (`xhigh` removed; the new GPT-5.6 `max`
  and `ultra` tiers are intentionally not exposed). The 5.6 models require
  Codex CLI >= 0.144.0.
- Updated command/agent/skill docs and README examples from gpt-5.5-era
  models to the 5.6 family, with regression coverage for alias mapping and
  effort validation.

## 1.6.0 (fork)

Native Claude Code visibility.

- Added hook-driven wake markers for terminal Codex jobs and reconciliation
  fallbacks. Stop and SessionStart hooks consume session-scoped markers and
  inject one-line `additionalContext` wake-ups.
- Added `lastActivity` summary pockets, updated from captured assistant
  progress, and surfaced them in `/codex:status` table and single-job output.
- Added opt-in `scripts/statusline.mts` plus `/codex:setup --statusline`
  instructions for a local-only Claude Code statusline.
- Added unit coverage for marker consume-once behavior and statusline output,
  plus an integration fixture for `lastActivity` capture.

## 1.5.1 (fork)

Test runner migration.

- Migrated the test suite from `node:test` to Vitest with separate unit and
  integration commands.
- Kept fixture-spawning tests in the integration command and capped Vitest
  workers at 6 to avoid local oversubscription.
- Replaced the two CI-only timing skips with per-test retry.

## 1.5.0 (fork)

Runtime TypeScript migration.

- Migrated the plugin runtime scripts from `.mjs` to native `.mts` TypeScript executed directly by Node type stripping; there is still no build step or compiled output.
- Raised the runtime requirement to Node.js 22.18+ and surfaced that requirement in `/codex:setup` readiness output and companion startup errors.
- Expanded TypeScript checking to include all plugin runtime `.mts` files with `erasableSyntaxOnly` enabled, and added concrete state/job/protocol record types for the control plane.

## 1.4.2 (fork)

Silent job-death elimination: streaming, reconciliation, and instrumentation.

- Fixed continue jobs streaming zero progress events (log frozen at "Thread
  ready" while the turn ran invisibly). Root cause: goal-bearing threads start
  a server-initiated goal-continuation turn the moment a user turn completes;
  a continue landing during it has its input absorbed into that turn, and the
  broker released stream ownership on the wrong turn's completion. The broker
  now releases on turn-id match, and `captureTurn` adopts the live root turn
  (with a grace window that re-latches if the prompt was requeued as its own
  turn instead). Verified against the real codex-cli 0.140.0 both ways.
- Durable turn-completion finalization, three independent layers:
  - every plugin-spawned `codex app-server` is configured with
    `-c notify=[node, turn-complete-hook.mts]`; codex itself invokes the hook
    when a turn finishes and the hook finalizes any job for that thread whose
    worker died or hung (grace-window + log-activity guarded);
  - workers poll `thread/turns/list` after 60s of event silence and
    synthesize the completion if the latest turn is terminal;
  - `status --wait`, `wait`, single-job `status`, and `alerts` finalize
    running jobs whose thread shows a terminal latest turn, surfaced as the
    new `completed-but-unreconciled` alert kind (distinct from `stalled`).
- Root-caused the silent worker deaths (OBS-B): a broker killed mid-turn (a
  concurrent session's SessionEnd, or broker replacement) closed the worker's
  socket, its completion promise never settled, and the drained event loop
  exited 0 with no trace. `captureTurn` now fails loudly when the runtime
  connection dies; workers also install uncaughtException/unhandledRejection/
  exit last-gasp handlers and route stdout/stderr into the job log.
- Native reviews log a synthesized 60s heartbeat (they emit no incremental
  events) and `alerts` treats silent native reviews as missed heartbeats with
  a tighter threshold.
- Unknown flags are rejected on every subcommand (a typo like `--promt-stdin`
  previously became prompt text silently); prose starting with a dash still
  works after a bare `--` separator.
- New `worktrees [--prune]` subcommand lists plugin worktrees under
  `~/.codex/worktrees` and prunes clean, inactive ones (dirty trees and
  active jobs are always kept; orphaned directories are deleted).
- `npm test` caps test-file concurrency at 6: the default 16-way parallelism
  oversubscribed the machine, tripling wall time and flaking timing tests.

## 1.4.1 (fork)

Sandbox correctness, single-item retrieval, and test reliability:

- Per-turn sandbox enforcement: every `turn/start` now carries a structured
  `sandboxPolicy` (and `approvalPolicy: never`) derived from the job's sandbox.
  Fixes `continue --full` silently running read-only on threads created
  read-only — the app-server ignores `thread/resume` overrides for loaded
  threads, but honors per-turn overrides unconditionally.
- `items` with a single matching item now returns its full text bounded only by
  `--budget`, instead of the fixed 400-char preview, so one complete
  agentMessage is retrievable (`--turn <id> --type agentMessage --limit 1`).
- `wait` pid-checks the job every 5s and reaps orphans, so a dead worker
  terminates the wait promptly instead of hanging to timeout.
- `status --wait --timeout-ms 0` means "wait until terminal" (6h safety cap),
  and background launches print the exact wait command as a wake-up hint.
- Test suite fixes: spawned companions no longer inherit `CLAUDE_PLUGIN_DATA` /
  `CODEX_COMPANION_SESSION_ID` from a hosting Claude Code session (18 tests
  failed when run inside one), and each test file kills the detached
  brokers/fake app-servers it spawned at exit (previously leaked by the
  hundreds).

## 1.4.0 (fork)

Job visibility and launch-control fixes:

- Explicit job ids for `status`, `result`, `tail`, `artifacts`, `cancel`, `steer`, and `goal` resolve across all Codex companion workspace state directories instead of being limited to the current session/workspace.
- Added `wait <job-id> [--timeout <seconds>]`, which watches the job JSON directory and falls back to a 2s stat poll, exiting as soon as the job reaches a terminal status.
- `task` now accepts `--prompt-stdin`, and both `task` and `continue` accept `--goal-file <path>` so multi-line prompts and shell metacharacters do not have to travel through argv.
- Every subcommand intercepts `-h`/`--help` before side effects, so help requests cannot start Codex work or mutate state.
- `review --background` and `adversarial-review --background` register a tracked job, spawn the detached worker, print the job id, and return promptly; slow review preparation runs inside the worker.
- Fallback state paths are canonicalized so parent processes and child workers agree on macOS `/var` versus `/private/var` temp paths.

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
