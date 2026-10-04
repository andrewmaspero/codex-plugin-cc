# Sol delegation early completion: investigation, 2026-10-04

## Root cause

The companion confuses an asynchronous user-input/status item with the end of the parent turn. Codex CLI 0.156.1 represents these items as `agentMessage`, `phase: final_answer`, `delivery: async`, with a nonempty `questions` array. Before this patch, `recordItem` latched `finalAnswerSeen` solely from the phase, and `scheduleInferredCompletion` synthesized success 250 ms later. `subAgentActivity` from native multi-agent execution was ignored, so the tracked legacy collab sets were empty even with native agents open. The log's claim that subagent work had drained was unsupported. A dedicated runtime could subsequently be shut down by `withSteerableAppServer`; a shared runtime could keep executing after its companion job had been marked completed.

The model emitted an unnecessary optional question, but did **not** end its turn in the strongest cases. No persisted subagent-result user message precedes the alleged final. The note's initial model-response-to-injected-message diagnosis is superseded by this evidence.

Before-fix source locations at origin/main `dda1b56`: `plugins/codex/scripts/lib/codex.mts:532` (inference), `:646` (legacy collab tracking), `:661` (agentMessage handling); fixed source: `:661` (async predicate), `:667` (native activity), `:924` (terminal confirmation). `plugins/codex/scripts/lib/control-plane.mts:1238` now resolves explicit alerts job IDs globally. Previously alerts consulted only the current workspace's capped index, unlike status/tail's durable global job lookup.

## Strongest evidence

| Job / parent thread | Sequence at false completion | Proof parent was not done |
| --- | --- | --- |
| `task-murvady7-264ka2` / `01a0ffee-945c-72f3-b44f-cb6bad826c02` | Completed command 04:08:05.761Z → reasoning → async question “No response is needed…” 04:08:12.012Z → companion inferred at 04:08:12.287Z | Four native starts and five interactions were not a child-drain signal; current first turn is interrupted. This case alone does not establish child liveness. |
| `task-musfvdao-u60sf2` / `01a101fe-171b-7783-914d-237a25136095` | Commands → async question “Optional task feedback…” → reasoning ×2 → commentary that work continues → owner recovery input → true final | The same turn continued after the async item and eventually completed after 50 minutes, versus companion completion at 29 minutes. |
| `task-musi0igd-6l7ij7` / `01a10235-0268-7c73-af97-0dff276ee91b` | Command started 14:52:01.744Z → async question “I’m proceeding…” 14:52:12.293Z → inferred at 14:52:12.544Z → reasoning → completed 24-second command → more work → true final | Parent was executing a command across the false completion; same turn later completed after 3h42m. |

The async item has the shape:

```json
{"type":"agentMessage","phase":"final_answer","delivery":"async","questions":[{"title":"No response is needed; I’m proceeding…","options":null}]}
```

Role/notification distinction: `userMessage` contains the original brief (and, in two cases, later explicit owner recovery); the suspected terminal item is the **parent's agentMessage**, not an injected user message. Native child activity appears as `subAgentActivity` with `kind`, `agentThreadId`, and `agentPath`. The persisted parent history does not reveal a separate model-visible mailbox/result message, so its unseen delivery role cannot honestly be asserted.

All original log hits were read through isolated source `tail`, `turns`, and bounded `items` viewers. Eight real jobs were checked: five stored an async item as their final output (`murvady7`, `musfvdao`, `musi0igd`, `muqbcsz4`, `mus5u81p`); three stored genuine synchronous finals (`murvoihk`, `murye84q`, `muqo5e5w`). The July fake thread `thr_1` no longer exists in real CLI history. A new unrelated job appearing during the investigation was excluded from the original cohort. Bounded raw RPC pages were used only to retain the small neighborhood around a matched stored result; no whole transcript or rollout file was read.

Local bounded evidence is in `.codex-artifacts/evidence/*-completion-sequence.json` and three investigator notes. Raw production history is intentionally not committed. Example safe command pattern (source only):

```sh
CLAUDE_PLUGIN_DATA="$PWD/.codex-artifacts/view-data" node plugins/codex/scripts/codex-companion.mts turns 01a10235-0268-7c73-af97-0dff276ee91b --limit 6 --json
CLAUDE_PLUGIN_DATA="$PWD/.codex-artifacts/view-data" node plugins/codex/scripts/codex-companion.mts items 01a10235-0268-7c73-af97-0dff276ee91b --turn 01a10235-050c-7282-b50f-3c0655a57d81 --type agentMessage,subAgentActivity --limit 12 --budget 7000 --json
```

Use an isolated cwd/data directory and unset `CODEX_COMPANION_APP_SERVER_ENDPOINT` and `CODEX_COMPANION_SESSION_ID`; do not point mutating commands at installed state.

## Answers to the grounding questions

1. **Companion bug**, with a model-generated optional async question as its trigger. Backend and package item sequences prove the parent continued. Evidence does not support treating a subagent notification as a user request and then voluntarily stopping.
2. **Not restricted to idle time between tools**: backend's command was still live. In the legacy collab path, a tracked pending `wait` blocks the old inference timer; draining that wait can then expose the same bug. Deterministic tests show old idle and just-drained failures, and an open tracked wait delaying inference. These field histories contain native activity rather than explicit waits, so a natural failure specifically while blocked on a native wait is not established.
3. **No documented delivery-mode configuration or prompt guarantees prevention.** Installed CLI help, generated protocol, `codex features list`, and the current configuration reference were checked. Legacy tool names are `spawnAgent`, `sendInput`, `resumeAgent`, `wait`, `closeAgent`, `sendMessage`, `followupTask`, `interruptAgent`, `listAgents`. Native v2 is enabled in the user config. Waiting is useful coordination guidance; it does not change the async item schema or turn-boundary contract. Native parent histories do not expose every hosted wait/result as a legacy collab item.

Official docs consulted: [app-server lifecycle](https://learn.chatgpt.com/docs/app-server) specifies `turn/completed` as the boundary; [subagent guidance](https://learn.chatgpt.com/docs/agent-configuration/subagents) recommends explicitly asking the parent to wait and synthesize; [configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference) exposes agent enablement/model/effort/interruption settings, not a completed-result user-message/tool-output selector. The absence of a guaranteed knob is a scoped finding, not proof that no future/internal setting could exist.

## Fix choices and limits

The lowest-level working fix is protocol-correct turn capture: async/questions never latch completion or become the returned final; synchronous inference requires a matching terminal turn confirmed by the server. Native activity is logged and remembered; the bounded viewer now exposes delivery/questions and native fields. Idle and read-side reconciliation omit async items when choosing output. The subagent-label race exposed under full-suite load is fixed by recording thread announcements immediately before the root turn id arrives.

**B + C** provide conservative fallback: fresh `task` jobs with observed delegation, an explicit nonempty output contract, and a short ongoing-work final automatically resume the same thread up to twice with the fixed nudge. Every recovery is logged; the same job stays running until recovery succeeds. Exhaustion fails with `suspect_early_completion`, visible through cross-workspace/durable alerts lookup. `--no-auto-continue` opts out. Reviews, explicit continue/resume, steer, short successful finals, and tasks without contracts do not acquire the recovery loop. **A** is not selected: changing prompts cannot repair a client interpreting an async question as terminal success.

Free-form contracts cannot be mechanically verified. The fallback treats an explicit short admission of ongoing work as evidence of incompleteness, rather than guessing paths or running arbitrary verification commands from a prose brief. Long or misleading success reports still need controller artifact checks. Auto-recovery's extra spend is bounded to two turns, but each turn has the job's usual execution limits.

## Validation

`pnpm test`: 188 passing (32 unit, 156 integration), including 14 new tests. `pnpm run typecheck` and `pnpm run check-version` pass. After the final reconciliation-output adjustment, all 31 affected delegation/control-plane/reconciliation tests pass again. One initial full run exposed the label race; the corrected full rerun passed.

Pre-fix deterministic replay failed with missing `verified.txt` in idle and just-drained modes; a held legacy wait delayed inference. Post-fix all modes wait for actual completion and the artifact. Separate tests cover genuine early finals with open/drained delegation, same-thread recovery, exactly two retries and failure/alert on exhaustion, disabled recovery, continue unchanged, normal short success, live synchronous items, question-only shape, viewer fields, and durable cross-workspace alerts.

Live results and reproducible source-only script are documented in [reproduction.md](reproduction.md). Plugin version: **1.11.1**. No installed plugin/cache/data was edited, no production job was controlled, and no plugin update/restart was run.
