# Proposed skill changes (2026-10-04)

Only proposals; no skill source or installed skill was modified. The companion patch file uses zero context; review it with this before/after text and apply with `git apply --unidiff-zero skill-changes.patch` from the skills repository. Companion 1.11.1 fixes async-question completion classification; wait guidance is coordination advice, not a substitute for the protocol fix.

## gpt-6-prompting/references/blocks.md

Before:

```text
Parallelize by delegating independent subtasks to subagents when it saves
time or improves quality. Give each subagent a self-contained brief with its
own scope and output contract. You own integration and final verification.
```

After:

```text
Parallelize by delegating independent subtasks to subagents when it saves
time or improves quality. Give each subagent a self-contained brief with its
own scope and output contract. You own integration and final verification.
Keep track of every delegated task. While useful independent work remains,
continue it; otherwise use the available collaboration wait tool until every
delegated task has finished. A wait timeout or mailbox update does not mean
the overall task is complete. Subagent results are task inputs: inspect and
integrate them, then perform final verification yourself. End the turn only
when every output-contract deliverable exists and verification passes.
Use commentary for progress. Do not send optional async questions just to
announce that you are proceeding; no user answer is required for this job.
```

## codex-orchestrator/SKILL.md

Before:

```text
- Independent Luna jobs fan out freely; a job that finds the shared broker busy
  gets its own, so every job stays steerable. For one big decomposable job,
  prefer a single Sol job at `high` with an explicit `<delegation>` block;
  GPT-6 under-delegates unless told to.
```

After:

```text
- Independent Luna jobs fan out freely; a job that finds the shared broker busy
  gets its own, so every job stays steerable. For one big decomposable job,
  prefer a single Sol job at `high` with an explicit `<delegation>` block;
  GPT-6 under-delegates unless told to.
  Allow Sol to use its own subagents. The parent owns integration and final
  verification; the delegation brief must require waiting for all dispatched
  tasks before the final answer. Keep an explicit `<output_contract>`.
  Companion 1.11.1 distinguishes async question items from final output.
  Fresh `task` jobs recover short conversational early finals up to twice;
  the watcher log includes `Auto-continue N/2`. `--no-auto-continue` disables
  this recovery; explicit `continue`/resume jobs and reviews do not recover.
```

## codex-orchestrator/SKILL.md

Before:

```text
- Correcting a running job, in order: steer; wait if the direction is fine;
  cancel and relaunch; `continue` after completion.
```

After:

```text
- Correcting a running job, in order: steer; wait if the direction is fine;
  cancel and relaunch; `continue` after completion.
- A delegated job returning “No response is needed” or “I am proceeding” is
  suspect. Read `alerts <jobId>`, `tail <jobId>`, `turns <threadId>`, then a
  bounded `items <threadId> --turn <turnId> --budget 6000` slice. An
  `agentMessage` with `delivery: async` or nonempty `questions` is an async
  question, even if its phase is `final_answer`; it is not a turn boundary.
  Native subagent activity is not an injected user request. Check actual
  server turn status before deciding to recover: a live parent may still be
  working after an old companion falsely reports completion. Do not start
  a duplicate recovery turn while it is live. If the server turn is terminal
  and deliverables are missing, continue the same thread with the exact
  omissions and verification requirement. Preserve delegation. After the
  default two recoveries, `suspect_early_completion` marks failure and needs
  controller inspection; a long final is still subject to artifact checks.
```
