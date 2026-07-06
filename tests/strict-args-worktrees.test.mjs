// Strict unknown-flag rejection (a mistyped flag used to become prompt text
// silently, e.g. `--promt-stdin` launching a job whose brief was the literal
// flag) and the `worktrees [--prune]` maintenance subcommand.
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { buildEnv, installFakeCodex } from "./fake-codex-fixture.mjs";
import { initGitRepo, makeTempDir, run } from "./helpers.mjs";
import { parseArgs } from "../plugins/codex/scripts/lib/args.mts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PLUGIN_ROOT = path.join(ROOT, "plugins", "codex");
const SCRIPT = path.join(PLUGIN_ROOT, "scripts", "codex-companion.mts");
const SESSION_HOOK = path.join(PLUGIN_ROOT, "scripts", "session-lifecycle-hook.mts");

function cleanEnv(binDir) {
  const env = buildEnv(binDir);
  delete env.CODEX_COMPANION_SESSION_ID;
  delete env.CODEX_COMPANION_TRANSCRIPT_PATH;
  delete env.CODEX_COMPANION_APP_SERVER_ENDPOINT;
  delete env.CLAUDE_PLUGIN_DATA;
  return env;
}

function makeRepo() {
  const repo = makeTempDir();
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  return repo;
}

function endSession(cwd, env) {
  run("node", [SESSION_HOOK, "SessionEnd"], {
    cwd,
    env,
    input: JSON.stringify({ hook_event_name: "SessionEnd", cwd })
  });
}

test("strict parseArgs rejects unknown flags but keeps passthrough and non-flag tokens", () => {
  assert.throws(
    () => parseArgs(["--promt-stdin"], { strict: true, booleanOptions: ["prompt-stdin"] }),
    /Unknown flag "--promt-stdin"/
  );
  assert.throws(() => parseArgs(["-z"], { strict: true }), /Unknown flag "-z"/);

  // Prose after a bare `--` is untouched.
  const passthrough = parseArgs(["--", "--not-a-flag", "keep this"], { strict: true });
  assert.deepEqual(passthrough.positionals, ["--not-a-flag", "keep this"]);

  // Bare dash and negative numbers stay positional.
  const nonFlags = parseArgs(["-", "-2"], { strict: true });
  assert.deepEqual(nonFlags.positionals, ["-", "-2"]);
});

test("companion subcommands reject mistyped flags with a clear error", () => {
  const repo = makeRepo();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  const env = cleanEnv(binDir);

  const task = run("node", [SCRIPT, "task", "--json", "--promt-stdin", "do a thing"], { cwd: repo, env });
  assert.equal(task.status, 1);
  assert.match(task.stderr, /Unknown flag "--promt-stdin"/);

  const status = run("node", [SCRIPT, "status", "--watch"], { cwd: repo, env });
  assert.equal(status.status, 1);
  assert.match(status.stderr, /Unknown flag "--watch"/);
});

test("worktrees lists and prunes plugin worktrees, keeping dirty ones", () => {
  const repo = makeRepo();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  const env = cleanEnv(binDir);
  env.CODEX_COMPANION_WORKTREE_ROOT = makeTempDir();

  try {
    const first = run("node", [SCRIPT, "task", "--json", "--worktree-name", "prunable", "clean worktree task"], {
      cwd: repo,
      env
    });
    assert.equal(first.status, 0, first.stderr);

    const second = run("node", [SCRIPT, "task", "--json", "--worktree-name", "kept", "dirty worktree task"], {
      cwd: repo,
      env
    });
    assert.equal(second.status, 0, second.stderr);

    const listed = run("node", [SCRIPT, "worktrees", "--json"], { cwd: repo, env });
    assert.equal(listed.status, 0, listed.stderr);
    const listPayload = JSON.parse(listed.stdout);
    assert.equal(listPayload.worktrees.length, 2, JSON.stringify(listPayload.worktrees));

    // Dirty the second worktree so prune must keep it.
    const keptEntry = listPayload.worktrees.find((entry) => entry.name === "cc-kept");
    assert.ok(keptEntry, "expected cc-kept worktree");
    fs.writeFileSync(path.join(keptEntry.worktreePath, "wip.txt"), "uncommitted\n");

    const pruned = run("node", [SCRIPT, "worktrees", "--prune", "--json"], { cwd: repo, env });
    assert.equal(pruned.status, 0, pruned.stderr);
    const prunePayload = JSON.parse(pruned.stdout);

    const removedNames = prunePayload.pruned.removed.map((entry) => entry.name);
    assert.deepEqual(removedNames, ["cc-prunable"], JSON.stringify(prunePayload.pruned));
    const keptNames = prunePayload.pruned.kept.map((entry) => `${entry.name}:${entry.reason}`);
    assert.ok(
      keptNames.includes("cc-kept:uncommitted changes"),
      `dirty worktree should be kept, got: ${keptNames.join(", ")}`
    );

    const prunableEntry = listPayload.worktrees.find((entry) => entry.name === "cc-prunable");
    assert.ok(!fs.existsSync(prunableEntry.worktreePath), "pruned worktree directory still exists");
    assert.ok(fs.existsSync(keptEntry.worktreePath), "kept worktree directory was removed");
  } finally {
    endSession(repo, env);
  }
});
