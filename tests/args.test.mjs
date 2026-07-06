import fs from "node:fs";
import path from "node:path";
import { test } from "vitest";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { buildEnv, installFakeCodex } from "./fake-codex-fixture.mjs";
import { initGitRepo, makeTempDir, run } from "./helpers.mjs";
import { parseArgs } from "../plugins/codex/scripts/lib/args.mts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PLUGIN_ROOT = path.join(ROOT, "plugins", "codex");
const SCRIPT = path.join(PLUGIN_ROOT, "scripts", "codex-companion.mts");

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
