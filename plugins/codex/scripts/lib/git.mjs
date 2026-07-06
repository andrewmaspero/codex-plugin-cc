import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { isProbablyText } from "./fs.mjs";
import { formatCommandFailure, runCommand, runCommandChecked } from "./process.mjs";

const MAX_UNTRACKED_BYTES = 24 * 1024;
const DEFAULT_INLINE_DIFF_MAX_FILES = 2;
const DEFAULT_INLINE_DIFF_MAX_BYTES = 256 * 1024;

function git(cwd, args, options = {}) {
  return runCommand("git", args, { cwd, ...options });
}

function gitChecked(cwd, args, options = {}) {
  return runCommandChecked("git", args, { cwd, ...options });
}

function listUniqueFiles(...groups) {
  return [...new Set(groups.flat().filter(Boolean))].sort();
}

function normalizeMaxInlineFiles(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return DEFAULT_INLINE_DIFF_MAX_FILES;
  }
  return Math.floor(parsed);
}

function normalizeMaxInlineDiffBytes(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return DEFAULT_INLINE_DIFF_MAX_BYTES;
  }
  return Math.floor(parsed);
}

function measureGitOutputBytes(cwd, args, maxBytes) {
  const result = git(cwd, args, { maxBuffer: maxBytes + 1 });
  if (result.error && /** @type {NodeJS.ErrnoException} */ (result.error).code === "ENOBUFS") {
    return maxBytes + 1;
  }
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(formatCommandFailure(result));
  }
  return Buffer.byteLength(result.stdout, "utf8");
}

function measureCombinedGitOutputBytes(cwd, argSets, maxBytes) {
  let totalBytes = 0;
  for (const args of argSets) {
    const remainingBytes = maxBytes - totalBytes;
    if (remainingBytes < 0) {
      return maxBytes + 1;
    }
    totalBytes += measureGitOutputBytes(cwd, args, remainingBytes);
    if (totalBytes > maxBytes) {
      return totalBytes;
    }
  }
  return totalBytes;
}

function buildBranchComparison(cwd, baseRef) {
  const mergeBase = gitChecked(cwd, ["merge-base", "HEAD", baseRef]).stdout.trim();
  return {
    mergeBase,
    commitRange: `${mergeBase}..HEAD`,
    reviewRange: `${baseRef}...HEAD`
  };
}

export function ensureGitRepository(cwd) {
  const result = git(cwd, ["rev-parse", "--show-toplevel"]);
  const errorCode = result.error && "code" in result.error ? result.error.code : null;
  if (errorCode === "ENOENT") {
    throw new Error("git is not installed. Install Git and retry.");
  }
  if (result.status !== 0) {
    throw new Error("This command must run inside a Git repository.");
  }
  return result.stdout.trim();
}

export function resolveWorktreeRoot(env = process.env) {
  return env.CODEX_COMPANION_WORKTREE_ROOT
    ? path.resolve(env.CODEX_COMPANION_WORKTREE_ROOT)
    : path.join(os.homedir(), ".codex", "worktrees");
}

/**
 * Create an isolated git worktree for a Codex job under the Codex worktree
 * root (outside the repo, so the main checkout stays clean). Branches are
 * namespaced `codex/<name>` off the current HEAD.
 */
export function createCodexWorktree(cwd, name, options = {}) {
  ensureGitRepository(cwd);
  const repoRoot = getRepoRoot(cwd);
  const repoName = path.basename(repoRoot) || "repo";
  const safeName =
    String(name ?? "")
      .replace(/[^a-zA-Z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "job";
  const worktreePath = path.join(resolveWorktreeRoot(options.env), `cc-${safeName}`, repoName);
  if (fs.existsSync(worktreePath)) {
    throw new Error(
      `Worktree path already exists: ${worktreePath}. Pass a different --worktree-name or remove it with \`git worktree remove\`.`
    );
  }
  const branch = `codex/${safeName}`;
  fs.mkdirSync(path.dirname(worktreePath), { recursive: true });
  gitChecked(repoRoot, ["worktree", "add", "-b", branch, worktreePath]);
  return { worktreePath, branch, repoRoot };
}

export function getRepoRoot(cwd) {
  return gitChecked(cwd, ["rev-parse", "--show-toplevel"]).stdout.trim();
}

/**
 * List plugin-created worktrees under the Codex worktree root
 * (`cc-<name>/<repoName>` directories created by createCodexWorktree).
 */
export function listCodexWorktrees(options = {}) {
  const root = resolveWorktreeRoot(options.env);
  if (!fs.existsSync(root)) {
    return [];
  }

  const entries = [];
  for (const groupEntry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!groupEntry.isDirectory() || !groupEntry.name.startsWith("cc-")) {
      continue;
    }
    const groupPath = path.join(root, groupEntry.name);
    for (const repoEntry of fs.readdirSync(groupPath, { withFileTypes: true })) {
      if (!repoEntry.isDirectory()) {
        continue;
      }
      const worktreePath = path.join(groupPath, repoEntry.name);
      const linked = fs.existsSync(path.join(worktreePath, ".git"));

      let branch = null;
      let dirty = null;
      let repoRoot = null;
      if (linked) {
        const branchResult = git(worktreePath, ["rev-parse", "--abbrev-ref", "HEAD"]);
        branch = branchResult.status === 0 ? branchResult.stdout.trim() || null : null;
        const statusResult = git(worktreePath, ["status", "--porcelain"]);
        dirty = statusResult.status === 0 ? statusResult.stdout.trim().length > 0 : null;
        const commonDir = git(worktreePath, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
        if (commonDir.status === 0) {
          const resolved = commonDir.stdout.trim();
          repoRoot = resolved.endsWith(`${path.sep}.git`) ? path.dirname(resolved) : resolved;
        }
      }

      let modifiedAt = null;
      try {
        modifiedAt = fs.statSync(worktreePath).mtime.toISOString();
      } catch {
        modifiedAt = null;
      }

      entries.push({
        name: groupEntry.name,
        worktreePath,
        branch,
        dirty,
        linked,
        repoRoot,
        modifiedAt
      });
    }
  }
  return entries.sort((left, right) => left.worktreePath.localeCompare(right.worktreePath));
}

function removeEmptyWorktreeGroup(worktreePath) {
  try {
    fs.rmdirSync(path.dirname(worktreePath));
  } catch {
    // Non-empty or already gone.
  }
}

/**
 * Remove plugin-created worktrees that are safe to drop: clean and not in
 * `keepPaths` (active jobs). Orphaned directories whose repo is gone are
 * deleted directly. Returns { removed, kept } descriptors.
 */
export function pruneCodexWorktrees(options = {}) {
  const keepPaths = new Set(options.keepPaths ?? []);
  const removed = [];
  const kept = [];

  for (const entry of listCodexWorktrees(options)) {
    if (keepPaths.has(entry.worktreePath)) {
      kept.push({ ...entry, reason: "active job" });
      continue;
    }
    if (entry.dirty === true) {
      kept.push({ ...entry, reason: "uncommitted changes" });
      continue;
    }

    if (entry.linked && entry.repoRoot && fs.existsSync(entry.repoRoot)) {
      const removal = git(entry.repoRoot, ["worktree", "remove", entry.worktreePath]);
      if (removal.status !== 0) {
        kept.push({
          ...entry,
          reason: `git worktree remove failed: ${removal.stderr.trim().split(/\r?\n/)[0] ?? "unknown error"}`
        });
        continue;
      }
      removeEmptyWorktreeGroup(entry.worktreePath);
      removed.push({ ...entry, reason: "clean" });
      continue;
    }

    // Orphaned directory: the linked repo is gone (or the .git link broke),
    // so git cannot remove it; delete the directory directly.
    try {
      fs.rmSync(entry.worktreePath, { recursive: true, force: true });
      removeEmptyWorktreeGroup(entry.worktreePath);
      removed.push({ ...entry, reason: "orphaned (repo missing)" });
    } catch (error) {
      kept.push({ ...entry, reason: `delete failed: ${error.message}` });
    }
  }

  return { removed, kept };
}

export function detectDefaultBranch(cwd) {
  const symbolic = git(cwd, ["symbolic-ref", "refs/remotes/origin/HEAD"]);
  if (symbolic.status === 0) {
    const remoteHead = symbolic.stdout.trim();
    if (remoteHead.startsWith("refs/remotes/origin/")) {
      return remoteHead.replace("refs/remotes/origin/", "");
    }
  }

  const candidates = ["main", "master", "trunk"];
  for (const candidate of candidates) {
    const local = git(cwd, ["show-ref", "--verify", "--quiet", `refs/heads/${candidate}`]);
    if (local.status === 0) {
      return candidate;
    }
    const remote = git(cwd, ["show-ref", "--verify", "--quiet", `refs/remotes/origin/${candidate}`]);
    if (remote.status === 0) {
      return `origin/${candidate}`;
    }
  }

  throw new Error("Unable to detect the repository default branch. Pass --base <ref> or use --scope working-tree.");
}

export function getCurrentBranch(cwd) {
  return gitChecked(cwd, ["branch", "--show-current"]).stdout.trim() || "HEAD";
}

export function getWorkingTreeState(cwd) {
  const staged = gitChecked(cwd, ["diff", "--cached", "--name-only"]).stdout.trim().split("\n").filter(Boolean);
  const unstaged = gitChecked(cwd, ["diff", "--name-only"]).stdout.trim().split("\n").filter(Boolean);
  const untracked = gitChecked(cwd, ["ls-files", "--others", "--exclude-standard"]).stdout.trim().split("\n").filter(Boolean);

  return {
    staged,
    unstaged,
    untracked,
    isDirty: staged.length > 0 || unstaged.length > 0 || untracked.length > 0
  };
}

export function resolveReviewTarget(cwd, options = {}) {
  ensureGitRepository(cwd);

  const requestedScope = options.scope ?? "auto";
  const baseRef = options.base ?? null;
  const state = getWorkingTreeState(cwd);
  const supportedScopes = new Set(["auto", "working-tree", "branch"]);

  if (baseRef) {
    return {
      mode: "branch",
      label: `branch diff against ${baseRef}`,
      baseRef,
      explicit: true
    };
  }

  if (requestedScope === "working-tree") {
    return {
      mode: "working-tree",
      label: "working tree diff",
      explicit: true
    };
  }

  if (!supportedScopes.has(requestedScope)) {
    throw new Error(
      `Unsupported review scope "${requestedScope}". Use one of: auto, working-tree, branch, or pass --base <ref>.`
    );
  }

  if (requestedScope === "branch") {
    const detectedBase = detectDefaultBranch(cwd);
    return {
      mode: "branch",
      label: `branch diff against ${detectedBase}`,
      baseRef: detectedBase,
      explicit: true
    };
  }

  if (state.isDirty) {
    return {
      mode: "working-tree",
      label: "working tree diff",
      explicit: false
    };
  }

  const detectedBase = detectDefaultBranch(cwd);
  return {
    mode: "branch",
    label: `branch diff against ${detectedBase}`,
    baseRef: detectedBase,
    explicit: false
  };
}

function formatSection(title, body) {
  return [`## ${title}`, "", body.trim() ? body.trim() : "(none)", ""].join("\n");
}

function formatUntrackedFile(cwd, relativePath) {
  const absolutePath = path.join(cwd, relativePath);
  let stat;
  try {
    stat = fs.statSync(absolutePath);
  } catch {
    return `### ${relativePath}\n(skipped: broken symlink or unreadable file)`;
  }
  if (stat.isDirectory()) {
    return `### ${relativePath}\n(skipped: directory)`;
  }
  if (stat.size > MAX_UNTRACKED_BYTES) {
    return `### ${relativePath}\n(skipped: ${stat.size} bytes exceeds ${MAX_UNTRACKED_BYTES} byte limit)`;
  }

  let buffer;
  try {
    buffer = fs.readFileSync(absolutePath);
  } catch {
    return `### ${relativePath}\n(skipped: broken symlink or unreadable file)`;
  }
  if (!isProbablyText(buffer)) {
    return `### ${relativePath}\n(skipped: binary file)`;
  }

  return [`### ${relativePath}`, "```", buffer.toString("utf8").trimEnd(), "```"].join("\n");
}

function collectWorkingTreeContext(cwd, state, options = {}) {
  const includeDiff = options.includeDiff !== false;
  const status = gitChecked(cwd, ["status", "--short", "--untracked-files=all"]).stdout.trim();
  const changedFiles = listUniqueFiles(state.staged, state.unstaged, state.untracked);

  let parts;
  if (includeDiff) {
    const stagedDiff = gitChecked(cwd, ["diff", "--cached", "--binary", "--no-ext-diff", "--submodule=diff"]).stdout;
    const unstagedDiff = gitChecked(cwd, ["diff", "--binary", "--no-ext-diff", "--submodule=diff"]).stdout;
    const untrackedBody = state.untracked.map((file) => formatUntrackedFile(cwd, file)).join("\n\n");
    parts = [
      formatSection("Git Status", status),
      formatSection("Staged Diff", stagedDiff),
      formatSection("Unstaged Diff", unstagedDiff),
      formatSection("Untracked Files", untrackedBody)
    ];
  } else {
    const stagedStat = gitChecked(cwd, ["diff", "--shortstat", "--cached"]).stdout.trim();
    const unstagedStat = gitChecked(cwd, ["diff", "--shortstat"]).stdout.trim();
    const untrackedBody = state.untracked.map((file) => formatUntrackedFile(cwd, file)).join("\n\n");
    parts = [
      formatSection("Git Status", status),
      formatSection("Staged Diff Stat", stagedStat),
      formatSection("Unstaged Diff Stat", unstagedStat),
      formatSection("Changed Files", changedFiles.join("\n")),
      formatSection("Untracked Files", untrackedBody)
    ];
  }

  return {
    mode: "working-tree",
    summary: `Reviewing ${state.staged.length} staged, ${state.unstaged.length} unstaged, and ${state.untracked.length} untracked file(s).`,
    content: parts.join("\n"),
    changedFiles
  };
}

function collectBranchContext(cwd, baseRef, options = {}) {
  const includeDiff = options.includeDiff !== false;
  const comparison = options.comparison ?? buildBranchComparison(cwd, baseRef);
  const currentBranch = getCurrentBranch(cwd);
  const changedFiles = gitChecked(cwd, ["diff", "--name-only", comparison.commitRange]).stdout.trim().split("\n").filter(Boolean);
  const logOutput = gitChecked(cwd, ["log", "--oneline", "--decorate", comparison.commitRange]).stdout.trim();
  const diffStat = gitChecked(cwd, ["diff", "--stat", comparison.commitRange]).stdout.trim();

  return {
    mode: "branch",
    summary: `Reviewing branch ${currentBranch} against ${baseRef} from merge-base ${comparison.mergeBase}.`,
    content: includeDiff
      ? [
          formatSection("Commit Log", logOutput),
          formatSection("Diff Stat", diffStat),
          formatSection(
            "Branch Diff",
            gitChecked(cwd, ["diff", "--binary", "--no-ext-diff", "--submodule=diff", comparison.commitRange]).stdout
          )
        ].join("\n")
      : [
          formatSection("Commit Log", logOutput),
          formatSection("Diff Stat", diffStat),
          formatSection("Changed Files", changedFiles.join("\n"))
        ].join("\n"),
    changedFiles,
    comparison
  };
}

function buildAdversarialCollectionGuidance(options = {}) {
  if (options.includeDiff !== false) {
    return "Use the repository context below as primary evidence.";
  }

  return "The repository context below is a lightweight summary. Inspect the target diff yourself with read-only git commands before finalizing findings.";
}

export function collectReviewContext(cwd, target, options = {}) {
  const repoRoot = getRepoRoot(cwd);
  const currentBranch = getCurrentBranch(repoRoot);
  const maxInlineFiles = normalizeMaxInlineFiles(options.maxInlineFiles);
  const maxInlineDiffBytes = normalizeMaxInlineDiffBytes(options.maxInlineDiffBytes);
  let details;
  let includeDiff;
  let diffBytes;

  if (target.mode === "working-tree") {
    const state = getWorkingTreeState(repoRoot);
    diffBytes = measureCombinedGitOutputBytes(
      repoRoot,
      [
        ["diff", "--cached", "--binary", "--no-ext-diff", "--submodule=diff"],
        ["diff", "--binary", "--no-ext-diff", "--submodule=diff"]
      ],
      maxInlineDiffBytes
    );
    includeDiff =
      options.includeDiff ??
      (listUniqueFiles(state.staged, state.unstaged, state.untracked).length <= maxInlineFiles &&
        diffBytes <= maxInlineDiffBytes);
    details = collectWorkingTreeContext(repoRoot, state, { includeDiff });
  } else {
    const comparison = buildBranchComparison(repoRoot, target.baseRef);
    const fileCount = gitChecked(repoRoot, ["diff", "--name-only", comparison.commitRange]).stdout.trim().split("\n").filter(Boolean).length;
    diffBytes = measureGitOutputBytes(
      repoRoot,
      ["diff", "--binary", "--no-ext-diff", "--submodule=diff", comparison.commitRange],
      maxInlineDiffBytes
    );
    includeDiff = options.includeDiff ?? (fileCount <= maxInlineFiles && diffBytes <= maxInlineDiffBytes);
    details = collectBranchContext(repoRoot, target.baseRef, { includeDiff, comparison });
  }

  return {
    cwd: repoRoot,
    repoRoot,
    branch: currentBranch,
    target,
    fileCount: details.changedFiles.length,
    diffBytes,
    inputMode: includeDiff ? "inline-diff" : "self-collect",
    collectionGuidance: buildAdversarialCollectionGuidance({ includeDiff }),
    ...details
  };
}
