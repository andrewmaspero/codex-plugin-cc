---
name: gpt-6-prompting
description: "Internal guidance for the Codex plugin: write briefs, steering deltas, and goals for GPT-6 Luna, Sol, and Astra, pick the model and reasoning effort, and use Astra to author prompts for other models. Load before composing any task, continue, steer, or goal text."
user-invocable: false
---

<!-- Canonical source: andrewmaspero/codex-skills skills/gpt-6-prompting. Body below this comment is byte-identical to the canonical SKILL.md below its frontmatter; only the frontmatter differs, and agents/openai.yaml exists only in the canonical repo. Keep in sync. -->

# GPT-6 Prompting

Write for a capable operator who follows the brief literally, reads every
instruction file in the repository, and will stop to ask a question that
nobody in a background job can answer.

This skill covers the writing. Launching, watching, steering, and recovering
jobs is the `codex-orchestrator` skill.

## How claims are labelled

Three kinds of claim appear here, and the label says how far to trust each.

- **OpenAI:** documented in the [GPT-6 model guide](https://developers.openai.com/api/docs/guides/latest-model).
- **Verified:** observed in live Codex runs on 25 September 2026 with plugin
  1.9.0.
- **Operator:** the owner's experience across many jobs. A working default,
  not a benchmark.

Anything unlabelled is a writing rule, not a fact about the model. Recheck the
OpenAI guide when a new release ships.

## Pick the model

| model | slug | $ in/out per 1M | efforts | use it for |
|---|---|---|---|---|
| Luna | `gpt-6-luna` | 0.10 / 0.50 | none, low, medium, high | Research, lookups, codebase scans, bulk vision (screenshots, documents, image triage), data extraction, and coding under a strict spec. |
| Sol | `gpt-6-sol` | 2 / 10 | none, low, medium, high | Multi-file implementation, debugging, test and lint loops, reviews. The default for anything that has to be right. |
| Astra | `gpt-6-astra` | 10 / 50 | low, medium | Architecture reviews and second opinions, prompt authoring for other models, complex computer use (for example redrawing a drawing in Figma), 3D and CAD. |

Operator notes on each:

- Luna is effectively free. It handles bulk multi-image vision well even at
  effort `none`, and it codes well when the spec is strict and drifts when the
  spec is loose. Run many Luna jobs in parallel rather than one big one.
- Sol is the reliable, thorough workhorse. Its output is normally ready to
  review and merge.
- Astra costs as much as Fable 5.1. Use it sparingly and never above `medium`.
  Writing prompts for other LLMs and VLMs is its standout strength.

Effort:

- Luna: `none` or `low` for lookups, extraction, and bulk vision; `medium` for
  research and coding; `high` only when a `medium` run demonstrably fell short.
  (Verified: Luna accepts `none`.)
- Sol: `medium` by default, `high` for large multi-part jobs, `low` for small
  edits.
- Astra: `low` or `medium` (defaults to `medium` when no effort is given).
- Tighten the brief before raising effort. A sharper contract beats more
  reasoning.

Escalate without asking when output misses the bar: Luna to Sol, Sol to Astra
or a Claude reviewer. Judge the output, not the price.

## What GPT-6 does with a brief

Every brief has to handle these seven behaviours. The block column names the
block in [references/blocks.md](references/blocks.md) that handles each one.

| behaviour | source | block |
|---|---|---|
| Asks a clarifying question instead of acting on a reasonable assumption. In a background job the question ends the turn. | OpenAI | `<autonomy>` |
| Weighs `AGENTS.md`, `CLAUDE.md`, and skill files heavily, including rules like "push, open a PR, and merge". | OpenAI | `<repo_policy>` |
| Fills routine gaps but guesses or skips consequential ones. Luna is the most literal of the three. | Operator | `<task>`, `<scope>` |
| Writes Markdown lists and tables by default, with stock phrases. | OpenAI | `<output_contract>` |
| Over-tests small changes and runs broader verification than the change needs. | OpenAI | `<verification>` |
| Delegates to its own subagents less than it should, so decomposable work runs serially. | OpenAI | `<delegation>` |
| Says almost nothing while it works. Codex runs GPT-6 at low verbosity, so the log shows only commands. | Verified | `<progress_updates>` |

Two consequences that are easy to miss:

- Repository instruction files are read before the brief is. If the brief
  is silent on git, the repository's automation rules decide what happens to
  the branch. State branch, commit, push, PR, and merge permissions every
  time, and say that the brief takes precedence over instruction files.
- Luna and Sol were briefed with these blocks on 25 September 2026 and
  behaved as intended; Astra was not exercised.

## Brief shape

Use XML-tagged blocks. They keep long briefs readable and let a steering
delta name the block it amends. The minimum for any Codex job:

```xml
<task>What to do, where (absolute repo path), and what done looks like.</task>
<autonomy>No questions; decision rules; a BLOCKED report when evidence or permission is missing; a budget.</autonomy>
<repo_policy>Branch, commit, push, PR, and merge permissions. The brief overrides instruction files.</repo_policy>
<scope>Allowed paths. Forbidden paths. No unrelated refactors.</scope>
<verification>Exact commands and pass criteria. What not to test.</verification>
<progress_updates>One line before and after each step.</progress_updates>
<output_contract>The exact shape of the final message, with a word cap or a schema.</output_contract>
```

Add `<grounding>` for research and review, `<delegation>` for large
decomposable jobs on Sol or Astra, `<vision>` for image work, and
`<stop_rules>` for loops. Copy the full text of each block from
[references/blocks.md](references/blocks.md). Per-model skeletons are in
[references/recipes.md](references/recipes.md).

`<progress_updates>` is what makes a background job watchable. (Verified:
each step produces a progress line that `/codex:tail` shows and that
`codex-orchestrator`'s `scripts/watch-jobs.sh` relays as live updates.)

## Check the brief before launching

Read the brief once as the worker would, with no memory of the conversation
that produced it. Then answer each question. A "no" means the brief is not
ready.

1. **Done state.** Can the worker tell, without asking, when it is finished?
   Done has to point at something checkable: a command that passes, a file
   that exists, a list of fields filled in.
2. **First ambiguity.** Find the first decision the brief leaves open. Either
   make it or give the rule for making it. Repeat until the next open
   decision is one you would accept either way.
3. **Git.** Does the brief say what the worker may do with branches, commits,
   pushes, and PRs? If not, the repository's `AGENTS.md` decides.
4. **Location.** Absolute checkout path, branch, base SHA, allowed paths,
   forbidden paths.
5. **Verification.** Named commands with pass criteria, not "make sure the
   tests pass". Say what not to test, or Sol will write tests for a one-line
   change.
6. **Output.** Who reads the final message, and in what shape? A parser gets a
   schema. A person gets a form and a word cap.
7. **Progress.** `<progress_updates>` is present if anyone will watch the job.
8. **Model fit.** Luna coding needs a spec you could hand to a contractor:
   files, signatures, behaviour, acceptance tests. If you cannot write that
   spec, the job is Sol's. Astra needs a reason from its column in the table.
9. **Nothing pasted.** Files and transcripts are referenced by path, not
   copied in. The worker can read them.

For a brief that will run many times or gate expensive work, add a cheap
second reading: launch Luna at effort `low`, sandbox read-only, with "Read the
brief below as the worker who will run it. List every question you would
need to ask and every decision it leaves to you. Do not do the task." A reader
from the same model family finds the gaps the author cannot.

## Steering and goals

A steer is a delta, not a new brief. Say what changed, what to stop, and the
next expected output, in under 150 words, and name the block or item it
amends. (Verified: `steer <job> --message-stdin` reaches a running job
mid-turn; completed work is preserved and the model applies the delta at its
next reasoning step.)

```text
Correction to item 3: the migration must keep the old column until the
backfill job has run. Stop the drop-column change. Next output: the revised
migration file and the backfill script, then continue with item 4.
```

If a steer changes what "done" means, update the goal as well. A goal
objective states the outcome in one sentence, then checkable acceptance
criteria, a loop rule ("after every change re-run X before moving on"), and
a stop rule ("after 3 distinct failed fixes, mark blocked and summarize").
Goals persist across turns and compaction; steers do not.

## Astra as prompt author

Astra writes prompts that other models follow unusually well (Operator). Use
it at effort `medium` for an LLM or VLM pipeline, a classifier, an extraction
prompt, a Luna fan-out brief that will run thousands of times, or a system
prompt. Give it the target model and effort, real sample inputs, the failure
cases you have seen, and the output schema; ask for the prompt plus a test
set. Validate independently before adopting: the recipe in
[references/recipes.md](references/recipes.md#astra-prompt-author) says how.

## Choose the command

These are companion CLI subcommands, not `/codex:` slash commands; the
`codex-orchestrator` skill covers launching them.

- `review` or `adversarial-review` for a review of local git changes. Their
  prompts already carry the review contract.
- Use `task` when the task is diagnosis, planning, research, or
  implementation: you write the whole brief.
- `continue <thread-id>` or `task --resume-last` for a follow-up on the same
  thread. It keeps the thread's model; send only the delta.

## Anti-patterns

- "Look into X and fix whatever seems wrong": no done state, so Luna stops
  early and Sol wanders.
- Leaving git behaviour to the repository's `AGENTS.md`, which is how workers
  push and merge on their own.
- "Confirm with me before …" in a background job. Nobody will answer; give
  the decision rule instead.
- Pasting whole files or transcripts instead of paths.
- Raising effort to rescue a vague brief.
- Astra for bulk work, or Astra above `medium`.
- A steer that restates the whole task. The worker already has it; send the
  delta.
