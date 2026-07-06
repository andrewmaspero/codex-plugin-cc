import fs from "node:fs";
import path from "node:path";
import { test } from "vitest";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { buildEnv, installFakeCodex } from "./fake-codex-fixture.mjs";
import { initGitRepo, makeTempDir, run } from "./helpers.mjs";

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
