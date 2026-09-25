import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { test } from "vitest";

import { buildEnv, installFakeCodex } from "./fake-codex-fixture.mjs";
import { initGitRepo, makeTempDir, run } from "./helpers.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = path.join(ROOT, "plugins", "codex", "scripts", "codex-companion.mts");
const SESSION_HOOK = path.join(ROOT, "plugins", "codex", "scripts", "session-lifecycle-hook.mts");

test("native Astra review pins thread reasoning effort at medium", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "initial\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "initial"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "README.md"), "changed\n");
  const env = buildEnv(binDir);

  try {
    const result = run("node", [SCRIPT, "review", "--model", "astra"], { cwd: repo, env });
    assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
    const state = JSON.parse(fs.readFileSync(path.join(binDir, "fake-codex-state.json"), "utf8"));
    assert.equal(state.lastThreadStart.params.model, "gpt-6-astra");
    assert.deepEqual(state.lastThreadStart.params.config, { model_reasoning_effort: "medium" });
  } finally {
    run("node", [SESSION_HOOK, "SessionEnd"], {
      cwd: repo,
      env,
      input: JSON.stringify({ hook_event_name: "SessionEnd", cwd: repo })
    });
  }
});

test("adversarial Astra review sends medium effort on its turn", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "initial\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "initial"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "README.md"), "changed\n");
  const env = buildEnv(binDir);
  try {
    const result = run("node", [SCRIPT, "adversarial-review", "--model", "astra"], { cwd: repo, env });
    assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
    const state = JSON.parse(fs.readFileSync(path.join(binDir, "fake-codex-state.json"), "utf8"));
    assert.equal(state.lastTurnStart.model, "gpt-6-astra");
    assert.equal(state.lastTurnStart.effort, "medium");
  } finally {
    run("node", [SESSION_HOOK, "SessionEnd"], {
      cwd: repo,
      env,
      input: JSON.stringify({ hook_event_name: "SessionEnd", cwd: repo })
    });
  }
});
