# Reproduction results, 2026-10-04

All runs used the worktree's source companion, `task --background --full --model sol --effort high`, and distinct throwaway git repositories beneath `.codex-artifacts/`. `CLAUDE_PLUGIN_DATA` and session ID were isolated; no installed broker endpoint was inherited. The model spawned two trivial subagents and owned integration/verification itself.

| Code | Brief | Early completions / runs | Result |
| --- | --- | --- | --- |
| origin/main `dda1b56` | Ordinary delegation, two idle-work probes and one explicit-wait probe | 0/3 | Correct final and all three files. |
| origin/main `dda1b56` | Controlled optional async-status probe, same deliverables | 1/1 | `completed` with the async one-liner; all three files were created **after** reported completion. |
| Patched 1.11.1 | Same controlled optional async-status brief | 0/1 | Correct verified final and all files present at first terminal observation. |

Combined pre-fix live frequency: **1/4**. This is a targeted protocol reproduction, not a claimed statistical failure rate for normal briefs. The controlled brief deliberately selects the async status tool naturally observed in production; it does not instruct the model to stop or omit deliverables.

Before job `task-mut4xiwq-ffkryf`, thread `01a10480-5b0d-7e52-b803-a25f0f43eae7`: captured async status 2026-10-04T01:23:56Z; logged inferred completion at 01:23:56.542Z. macOS file creation times place alpha.txt **40.694s**, beta.txt **46.396s**, combined.txt **59.349s** after the job's completedAt. The shared runtime later kept working and created them, which independently demonstrates companion false completion rather than parent turn termination. The stored result remained the one-liner.

After job `task-mut54br1-38yors`, thread `01a10485-33dd-7fc1-bab7-7ebbd0d9dfe3`: native agents started; exact same async status at 01:26:59.558Z; both agents completed; parent verified files; real turn completed at 01:27:15.872Z. First terminal snapshot contained:

```json
{"status":"completed","files":{"alpha.txt":"alpha\n","beta.txt":"beta\n","combined.txt":"alpha\nbeta\n"},"rawOutput":"Verified all three files have the exact expected contents… Verification passed."}
```

The defect is deterministic in the fake protocol replay: pre-fix idle and drained cases return before `verified.txt` exists; patched cases return after real completion. Bounded recovery is exercised separately by actual terminal conversational finals in the fixture, never by sending a follow-up into a live async-status turn.

To repeat a live probe from this worktree's source:

```sh
python3 .codex-artifacts/reproduce.py unique-label
```

The script saves its brief, launch JSON and terminal artifact snapshot beneath `.codex-artifacts/live-unique-label/`; exit 1 means a missing/incorrect contract file at job completion. Use the same script in a throwaway checkout of `dda1b56` for the before case. It never targets or controls existing jobs. `.codex-artifacts/live-before-bounded.json`, `live-after-bounded.json`, local job logs and terminal snapshots retain the original observations; these raw captures are not published in the PR.
