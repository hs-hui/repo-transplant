import { createHash } from "node:crypto";
import {
  appendFile,
  copyFile,
  lstat,
  mkdir,
  readdir,
  readFile,
  readlink,
  rm,
  rmdir,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { TransplantError } from "../util/errors.js";
import { type ExecResult, git } from "../util/exec.js";
import { isBinary, mapLimit, pathExists, randomId, sha256 } from "../util/fsx.js";
import { normalizeNewlines } from "../util/text.js";
import { SESSION_SUFFIX } from "./store.js";

const GIT_TIMEOUT_MS = 300_000;
/** Reading every file one at a time takes half a minute on a repository of 35,000 files. */
const FILE_CONCURRENCY = 32;
const LOCKED_CONFIG = ["-c", `core.hooksPath=${os.devNull}`, "-c", "core.fsmonitor=false"];
/** Settings people change in the normal course of work, which cannot start anything. */
const ROUTINE_SETTING = /^(branch\.|user\.|gc\.|maintenance\.|remote\.[^\n]*\.(url|pushurl|fetch)\n)/i;
const LFS_FILTER = /^git-lfs (clean -- %f|smudge -- %f|filter-process)$/;
export const MAX_AUDIT_BYTES = 5 * 1024 * 1024;
const MAX_LCS_CELLS = 4_000_000;

/** Install output and caches. Skipped at any depth, unless git would commit what is inside. */
const DEPENDENCY_DIRS = new Set([
  "node_modules",
  "bower_components",
  ".venv",
  "venv",
  "__pycache__",
  ".pytest_cache",
  ".mypy_cache",
  ".ruff_cache",
  ".tox",
  ".next",
  ".nuxt",
  ".svelte-kit",
  ".output",
  ".turbo",
  ".cache",
  ".parcel-cache",
  ".gradle",
]);
/** Build output, but only beside a project manifest. `src/build/` is ordinary code. */
const BUILD_DIRS = new Set(["target", "dist", "build", "coverage"]);
const PROJECT_MARKER =
  /^(package\.json|go\.mod|Cargo\.toml|pyproject\.toml|setup\.py|composer\.json|pom\.xml|Gemfile|build\.gradle(\.kts)?)$/;

export const NOTICES_FILE = "THIRD_PARTY_NOTICES.md";

/**
 * Isolates read-only git calls from configuration a tampered repository could carry. Only plumbing
 * commands run here, against the git directory recorded at creation, never a path a worktree's
 * .git file names, so neither filters nor a decoy core.worktree have any effect.
 */
async function gitIn(
  gitDir: string,
  args: string[],
  options: { allowFailure?: boolean; env?: NodeJS.ProcessEnv } = {},
): Promise<ExecResult> {
  // An empty file, because git on Windows cannot open the null device as a config path.
  const emptyConfig = path.join(os.tmpdir(), "rt-empty-gitconfig");
  if (!(await pathExists(emptyConfig))) await writeFile(emptyConfig, "");
  const args2 = [
    "--no-replace-objects",
    "-c",
    "safe.directory=*",
    ...LOCKED_CONFIG,
    `--git-dir=${gitDir}`,
    ...args,
  ];
  return git(args2, {
    timeoutMs: GIT_TIMEOUT_MS,
    allowFailure: options.allowFailure,
    local: true,
    env: { GIT_CONFIG_GLOBAL: emptyConfig, GIT_CONFIG_NOSYSTEM: "1", ...options.env },
  });
}

/**
 * For repositories named by path. An agent chooses that path, and a repository's own settings can start
 * programs, so hooks and the file monitor stay off and no secrets reach these calls.
 */
function gitTarget(
  target: string,
  args: string[],
  options: { allowFailure?: boolean; timeoutMs?: number } = {},
): Promise<ExecResult> {
  return git([...LOCKED_CONFIG, "-C", target, ...args], { ...options, local: true });
}

/** Filter programs run on status and checkout, and no option turns them all off. LFS is the known one. */
async function assertNoRepositoryFilters(target: string): Promise<void> {
  const pattern = "^filter\\..*\\.(clean|smudge|process)$";
  const found = await gitTarget(target, ["config", "-z", "--show-scope", "--get-regexp", pattern], {
    allowFailure: true,
  });
  const refuse = (detail: string): TransplantError =>
    new TransplantError(
      "unsafe_target_config",
      `The repository's own git config runs a program: ${detail}`,
      "Remove the filter, or start from a fresh clone.",
    );
  // Exit 1 means nothing matched. Anything else means the settings could not be read.
  if (found.code !== 0 && found.code !== 1) throw refuse("the config could not be read");
  const fields = found.stdout.split("\0");
  for (let index = 0; index + 1 < fields.length; index += 2) {
    const entry = fields[index + 1]!;
    const newline = entry.indexOf("\n");
    const name = newline === -1 ? entry : entry.slice(0, newline);
    const value = newline === -1 ? "" : entry.slice(newline + 1);
    if (["local", "worktree"].includes(fields[index]!) && !LFS_FILTER.test(value)) throw refuse(name);
  }
}

export async function assertGitRepo(target: string): Promise<string> {
  const result = await gitTarget(target, ["rev-parse", "--show-toplevel"], { allowFailure: true });
  if (result.code !== 0) {
    throw new TransplantError(
      "target_not_git",
      `Target is not a git repository: ${target}`,
      "Transplants run in a git worktree so they can be reviewed and reverted. Run `git init` and commit first.",
    );
  }
  const root = path.resolve(result.stdout.trim());
  await assertNoRepositoryFilters(root);
  return root;
}

export interface TargetState {
  headSha: string;
  dirty: boolean;
  branch: string;
}

export async function readTargetState(target: string): Promise<TargetState> {
  const head = await gitTarget(target, ["rev-parse", "HEAD"], { allowFailure: true });
  if (head.code !== 0) {
    throw new TransplantError(
      "target_no_commits",
      "Target has no commits yet.",
      "Commit once so a worktree has a base.",
    );
  }
  const status = await gitTarget(target, ["status", "--porcelain", "--ignore-submodules=all"]);
  const branch = await gitTarget(target, ["rev-parse", "--abbrev-ref", "HEAD"]);
  return {
    headSha: head.stdout.trim(),
    dirty: status.stdout.trim().length > 0,
    branch: branch.stdout.trim(),
  };
}

export async function resolveCommit(target: string, ref: string): Promise<string> {
  if (!/^(?!-)[A-Za-z0-9._/-]+$/.test(ref))
    throw new TransplantError("invalid_ref", `Unsafe base ref: ${ref}`);
  return (await gitTarget(target, ["rev-parse", "--verify", `${ref}^{commit}`])).stdout.trim();
}

async function commonGitDir(target: string): Promise<string> {
  const common = (await gitTarget(target, ["rev-parse", "--git-common-dir"])).stdout.trim();
  return path.resolve(target, common);
}

async function excludeWorktrees(gitDir: string): Promise<void> {
  const excludeFile = path.join(gitDir, "info", "exclude");
  await mkdir(path.dirname(excludeFile), { recursive: true });
  const current = (await pathExists(excludeFile)) ? await readFile(excludeFile, "utf8") : "";
  if (!current.includes(".transplant/worktrees/")) {
    const separator = current.endsWith("\n") || !current ? "" : "\n";
    await appendFile(excludeFile, `${separator}**/.transplant/worktrees/\n`);
  }
}

export interface Workspace {
  path: string;
  branch: string;
  baseSha: string;
  /** The repository's real git directory, recorded before any transplanted code exists. */
  gitDir: string;
  /** Content hashes of files the tool wrote. A file is exempt from review only while it still matches. */
  toolFiles?: Record<string, string>;
  /** Hash of the repository settings that change what git does, taken when the worktree was created. */
  gitState?: string;
  /** What the worktree's .git file said at creation. Anything else there can run code on the next git call. */
  gitLink?: string;
  /** The worktree's private git folder, read from that file. A folder name could be someone else's. */
  adminDir?: string;
  /** Every branch at creation, to notice work placed outside this one. */
  refs?: Record<string, string>;
  /** The commit built from the reviewed files, once the user has asked for it. */
  commit?: string;
}

/**
 * Filters, hooks and attributes run when someone later stages or commits. No review of the files can
 * see their effect, so the review instead notices that they changed.
 */
async function hashGitState(gitDir: string): Promise<string> {
  const parts: string[] = [];
  const add = async (rel: string): Promise<void> => {
    const buffer = await readFile(path.join(gitDir, rel)).catch(() => null);
    if (buffer) parts.push(`${rel}\0${sha256(buffer)}`);
  };
  const settings = await gitIn(gitDir, ["config", "--local", "--list", "-z"], { allowFailure: true });
  const lines = settings.stdout.split("\0").filter((line) => !ROUTINE_SETTING.test(line));
  parts.push(`config\0${sha256(lines.join("\0"))}`);
  await add("config.worktree");
  await add("info/attributes");
  await add("info/exclude");
  for (const entry of (await readdir(path.join(gitDir, "hooks")).catch(() => [] as string[])).sort()) {
    await add(`hooks/${entry}`);
  }
  for (const entry of (await readdir(path.join(gitDir, "worktrees")).catch(() => [] as string[])).sort()) {
    await add(`worktrees/${entry}/config.worktree`);
  }
  return sha256(parts.join("\n"));
}

const worktreeParent = (target: string, root?: string): string =>
  root ?? path.join(target, ".transplant", "worktrees");

async function listRefs(gitDir: string): Promise<Map<string, string>> {
  const listed = await gitIn(gitDir, ["for-each-ref", "--format=%(objectname) %(refname)"]);
  const refs = new Map<string, string>();
  for (const line of listed.stdout.split("\n").filter(Boolean)) {
    const space = line.indexOf(" ");
    refs.set(line.slice(space + 1), line.slice(0, space));
  }
  return refs;
}

/** Taken when a session starts, so settings planted before the worktree exists also count as changes. */
export async function recordTargetSettings(target: string): Promise<string> {
  const gitDir = await commonGitDir(target);
  await excludeWorktrees(gitDir);
  return hashGitState(gitDir);
}

export async function createWorkspace(
  target: string,
  id: string,
  baseSha: string,
  options: { root?: string; settings?: string } = {},
): Promise<Workspace> {
  // Git refuses some paths on Windows at around 260 characters, so the folder gets the short part.
  const directory = path.join(worktreeParent(target, options.root), id.slice(-SESSION_SUFFIX));
  const branch = `transplant/${id}`;
  const gitDir = await commonGitDir(target);
  await assertNoRepositoryFilters(target);
  await excludeWorktrees(gitDir);
  if (options.settings !== undefined && options.settings !== (await hashGitState(gitDir))) {
    throw new TransplantError(
      "git_state_changed",
      "Git config, hooks or attributes changed since this session started.",
      "Restore them, or start a new session.",
    );
  }
  if (await pathExists(directory)) {
    throw new TransplantError("worktree_failed", `Already in use: ${directory}`);
  }
  await mkdir(path.dirname(directory), { recursive: true });
  const add = ["-c", "core.longpaths=true", "worktree", "add", "-q", "-b", branch, directory, baseSha];
  const created = await gitTarget(target, add, { allowFailure: true, timeoutMs: GIT_TIMEOUT_MS }).catch(
    (error: unknown) => ({ code: 1, stderr: String(error) }),
  );
  if (created.code !== 0) {
    // A half-made branch would make every retry fail with a different error.
    await gitTarget(target, ["worktree", "prune"], { allowFailure: true });
    await gitTarget(target, ["branch", "-D", branch], { allowFailure: true });
    await rm(directory, { recursive: true, force: true });
    const reason = created.stderr.trim().slice(0, 800);
    throw new TransplantError(
      "worktree_failed",
      `Could not create the worktree: ${reason}`,
      /too big|too long/i.test(reason)
        ? "The path is too long for git. Set RT_WORKTREE_ROOT to a short folder, or move the project."
        : undefined,
    );
  }
  const gitLink = await readFile(path.join(directory, ".git"), "utf8");
  return {
    path: directory,
    branch,
    baseSha,
    gitDir,
    gitState: await hashGitState(gitDir),
    gitLink,
    adminDir: path.resolve(directory, gitLink.replace(/^gitdir:\s*/, "").trim()),
    refs: Object.fromEntries(
      [...(await listRefs(gitDir))].filter(([name]) => name.startsWith("refs/heads/")),
    ),
  };
}

export async function removeWorkspace(
  target: string,
  workspace: Workspace,
  options: { deleteBranch: boolean; root?: string },
): Promise<void> {
  const allowed = [worktreeParent(target), worktreeParent(target, options.root)].map((dir) =>
    path.resolve(dir),
  );
  if (!allowed.includes(path.dirname(path.resolve(workspace.path)))) {
    throw new TransplantError("unsafe_path", `Refusing to remove unexpected path: ${workspace.path}`);
  }
  if (await pathExists(workspace.path)) {
    await gitTarget(target, ["worktree", "remove", "--force", workspace.path]);
  }
  await gitTarget(target, ["worktree", "prune"]);
  // Only succeeds once the last worktree is gone.
  await rmdir(path.dirname(workspace.path)).catch(() => undefined);
  if (options.deleteBranch) {
    await gitTarget(target, ["branch", "-D", workspace.branch], { allowFailure: true });
  }
}

/** Paths the report step may write. They count as tool output only while their hashes match. */
export function toolPaths(workspace: Workspace): string[] {
  const id = workspace.branch.replace(/^transplant\//, "");
  return [`.transplant/reports/${id}.md`, `.transplant/provenance/${id}.json`, NOTICES_FILE];
}

const gitBlobSha = (content: Buffer): string =>
  createHash("sha1").update(`blob ${content.length}\0`).update(content).digest("hex");

interface BaseEntry {
  mode: string;
  sha: string;
}

async function listBase(workspace: Workspace): Promise<Map<string, BaseEntry>> {
  const result = await gitIn(workspace.gitDir, ["ls-tree", "-r", "-z", "--full-tree", workspace.baseSha]);
  const entries = new Map<string, BaseEntry>();
  for (const record of result.stdout.split("\0").filter(Boolean)) {
    const tab = record.indexOf("\t");
    const [mode, , sha] = record.slice(0, tab).split(" ");
    entries.set(record.slice(tab + 1), { mode: mode!, sha: sha! });
  }
  return entries;
}

/**
 * Untracked files git would commit. Asked against a throwaway index built from the base commit, since
 * the shared index belongs to the main checkout, and the worktree's own can be corrupted to hide files.
 */
async function listCommittable(workspace: Workspace): Promise<string[]> {
  const index = path.join(os.tmpdir(), `rt-index-${randomId(8)}`);
  const env = { GIT_INDEX_FILE: index };
  try {
    await gitIn(workspace.gitDir, ["read-tree", workspace.baseSha], { env });
    const result = await gitIn(
      workspace.gitDir,
      [`--work-tree=${workspace.path}`, "ls-files", "--others", "--exclude-standard", "-z"],
      { env },
    );
    return result.stdout.split("\0").filter(Boolean);
  } finally {
    await rm(index, { force: true }).catch(() => undefined);
  }
}

export interface ChangedFile {
  path: string;
  status: "added" | "modified" | "deleted";
  symlink: boolean;
}

export interface FileContent {
  file: string;
  status: "added" | "modified";
  text: string;
  binary: boolean;
  tooLarge: boolean;
  addedLines: Set<number>;
}

export interface WorktreeFile {
  path: string;
  hash: string;
  symlink: boolean;
}

export interface TreeReview {
  fingerprint: string;
  changed: ChangedFile[];
  contents: FileContent[];
  files: WorktreeFile[];
  gitStateChanged: boolean;
  /** The review covers files on disk. Commits on the branch would reach a merge without being seen. */
  branchMoved: boolean;
  gitLinkChanged: boolean;
  /** The worktree's index no longer matches its commit, so a commit made from it may differ from the review. */
  indexChanged: boolean;
  /** Refs that change what the branch name, or any object, resolves to. */
  shadowingRefs: string[];
  /** Branches outside this session that moved. People do that too, so this only gets reported. */
  movedBranches: string[];
}

/** A line-level diff. Past the size limit, everything between the common ends counts as added. */
function addedLineNumbers(oldText: string, newText: string): Set<number> {
  const before = oldText.split("\n");
  const after = newText.split("\n");
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start++;
  let endBefore = before.length;
  let endAfter = after.length;
  while (endBefore > start && endAfter > start && before[endBefore - 1] === after[endAfter - 1]) {
    endBefore--;
    endAfter--;
  }
  const rows = endBefore - start;
  const columns = endAfter - start;
  const added = new Set<number>();
  for (let index = 0; index < columns; index++) added.add(start + index + 1);
  if (rows === 0 || columns === 0 || rows * columns > MAX_LCS_CELLS) return added;

  const width = columns + 1;
  const lengths = new Uint32Array((rows + 1) * width);
  for (let row = rows - 1; row >= 0; row--) {
    for (let column = columns - 1; column >= 0; column--) {
      lengths[row * width + column] =
        before[start + row] === after[start + column]
          ? lengths[(row + 1) * width + column + 1]! + 1
          : Math.max(lengths[(row + 1) * width + column]!, lengths[row * width + column + 1]!);
    }
  }
  let row = 0;
  let column = 0;
  while (row < rows && column < columns) {
    if (before[start + row] === after[start + column]) {
      added.delete(start + column + 1);
      row++;
      column++;
    } else if (lengths[(row + 1) * width + column]! >= lengths[row * width + column + 1]!) {
      row++;
    } else {
      column++;
    }
  }
  return added;
}

/** Compares the tree the worktree's index would commit, read from a copy so nothing touches the original. */
async function indexMatches(workspace: Workspace, commit: string): Promise<boolean> {
  if (!workspace.adminDir) return true;
  const copy = path.join(os.tmpdir(), `rt-index-${randomId(8)}`);
  try {
    await copyFile(path.join(workspace.adminDir, "index"), copy);
    const env = { GIT_INDEX_FILE: copy };
    const written = await gitIn(workspace.gitDir, ["write-tree", "--missing-ok"], {
      allowFailure: true,
      env,
    });
    const expected = await gitIn(workspace.gitDir, ["rev-parse", `${commit}^{tree}`]);
    return written.code === 0 && written.stdout.trim() === expected.stdout.trim();
  } catch {
    return false;
  } finally {
    await rm(copy, { force: true }).catch(() => undefined);
  }
}

/** Reads the git state that can reach a merge without appearing in the worktree's files. */
async function readBranchState(workspace: Workspace) {
  const refs = await listRefs(workspace.gitDir);
  const own = `refs/heads/${workspace.branch}`;
  const tip = refs.get(own) ?? "";
  const expected = workspace.commit ?? workspace.baseSha;
  const link = await readFile(path.join(workspace.path, ".git"), "utf8").catch(() => null);
  const before = workspace.refs ?? {};
  const names = [...refs.keys()].sort();
  return {
    tip,
    branchMoved: tip !== expected,
    gitLinkChanged: link !== workspace.gitLink,
    indexChanged: !(await indexMatches(workspace, expected)),
    shadowingRefs: names.filter(
      (name) =>
        name.startsWith("refs/replace/") ||
        (name !== own && !name.startsWith("refs/remotes/") && name.endsWith(`/${workspace.branch}`)),
    ),
    movedBranches: names.filter(
      (name) =>
        name.startsWith("refs/heads/") &&
        !name.startsWith("refs/heads/transplant/") &&
        before[name] !== undefined &&
        before[name] !== refs.get(name),
    ),
  };
}

export async function showBaseFile(workspace: Workspace, rel: string): Promise<string | null> {
  const result = await gitIn(workspace.gitDir, ["cat-file", "blob", `${workspace.baseSha}:${rel}`], {
    allowFailure: true,
  });
  return result.code === 0 ? result.stdout : null;
}

/**
 * Reads the worktree from the filesystem and compares it with the base commit's blobs. Git is asked
 * only what the base commit holds and what it would commit, so its index flags, filters, attributes,
 * diff drivers and hidden directory rules cannot change what gets reviewed. Everything that reaches
 * verification comes from this same walk.
 */
export async function reviewTree(workspace: Workspace): Promise<TreeReview> {
  const base = await listBase(workspace);
  const baseDirs = new Set<string>();
  for (const rel of base.keys()) {
    for (let slash = rel.indexOf("/"); slash !== -1; slash = rel.indexOf("/", slash + 1)) {
      baseDirs.add(rel.slice(0, slash));
    }
  }
  const committableDirs = new Set<string>();
  for (const rel of await listCommittable(workspace)) {
    for (let slash = rel.indexOf("/"); slash !== -1; slash = rel.indexOf("/", slash + 1)) {
      committableDirs.add(rel.slice(0, slash));
    }
  }

  const tool = workspace.toolFiles ?? {};
  const pending: { rel: string; symlink: boolean }[] = [];
  const stack = [""];

  while (stack.length > 0) {
    const relDir = stack.pop()!;
    const entries = await readdir(path.join(workspace.path, relDir), { withFileTypes: true });
    const isProject = relDir === "" || entries.some((entry) => PROJECT_MARKER.test(entry.name));
    for (const entry of entries) {
      const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
      if (rel === ".git") continue;
      if (entry.isDirectory()) {
        const generated = DEPENDENCY_DIRS.has(entry.name) || (isProject && BUILD_DIRS.has(entry.name));
        if (!generated || baseDirs.has(rel) || committableDirs.has(rel)) stack.push(rel);
      } else if (entry.isSymbolicLink() || entry.isFile()) {
        pending.push({ rel, symlink: entry.isSymbolicLink() });
      }
    }
  }

  const seen = new Set(pending.map((item) => item.rel));
  const inspected = await mapLimit(pending, FILE_CONCURRENCY, async ({ rel, symlink }) => {
    const absolute = path.join(workspace.path, rel);
    const buffer = symlink ? Buffer.from(await readlink(absolute)) : await readFile(absolute);
    const hash = sha256(buffer);
    if (tool[rel] === hash) return {};
    const file: WorktreeFile = { path: rel, hash, symlink };

    const known = base.get(rel);
    const binary = isBinary(buffer) || buffer.includes(0);
    const unchanged =
      known !== undefined &&
      (known.sha === gitBlobSha(buffer) ||
        // A checkout may hold CRLF for a blob stored with LF. A lone CR is a real edit, though,
        // because it joins two lines for anything that reads LF.
        (!binary &&
          !/\r(?!\n)/.test(buffer.toString("utf8")) &&
          known.sha === gitBlobSha(Buffer.from(normalizeNewlines(buffer.toString("utf8"))))));
    if (unchanged) return { file };

    const status: "added" | "modified" = known ? "modified" : "added";
    const change: ChangedFile = { path: rel, status, symlink };
    if (symlink) return { file, change };
    if (buffer.length > MAX_AUDIT_BYTES) {
      const content = { file: rel, status, text: "", binary, tooLarge: true, addedLines: new Set<number>() };
      return { file, change, content };
    }
    const text = normalizeNewlines(buffer.toString("utf8"));
    const before = known ? await showBaseFile(workspace, rel) : null;
    const addedLines = addedLineNumbers(normalizeNewlines(before ?? ""), text);
    return { file, change, content: { file: rel, status, text, binary, tooLarge: false, addedLines } };
  });
  const files = inspected.flatMap((item) => (item.file ? [item.file] : []));
  const changed = inspected.flatMap((item) => (item.change ? [item.change] : []));
  const contents: FileContent[] = inspected.flatMap((item) => (item.content ? [item.content] : []));

  for (const [rel, entry] of base) {
    if (!seen.has(rel) && entry.mode !== "160000") {
      changed.push({ path: rel, status: "deleted", symlink: false });
    }
  }
  files.sort((a, b) => (a.path < b.path ? -1 : 1));
  changed.sort((a, b) => (a.path < b.path ? -1 : 1));
  const gitState = await hashGitState(workspace.gitDir);
  const branch = await readBranchState(workspace);
  const state = [
    gitState,
    branch.tip,
    branch.gitLinkChanged,
    branch.indexChanged,
    ...branch.shadowingRefs,
  ].join("\0");
  const listing = files.map((file) => `${file.path}\0${file.hash}`).join("\n");
  return {
    fingerprint: sha256(`${state}\n${listing}`).slice(0, 40),
    changed,
    contents,
    files,
    gitStateChanged: workspace.gitState !== undefined && workspace.gitState !== gitState,
    branchMoved: branch.branchMoved,
    gitLinkChanged: branch.gitLinkChanged,
    indexChanged: branch.indexChanged,
    shadowingRefs: branch.shadowingRefs,
    movedBranches: branch.movedBranches,
  };
}

/** Evidence and audits are valid only for this exact set of files. */
export async function workspaceFingerprint(workspace: Workspace): Promise<string> {
  return (await reviewTree(workspace)).fingerprint;
}

/** Records what the report step wrote, so later edits to those files count as ordinary changes. */
export async function recordToolFiles(
  workspace: Workspace,
  options: { notices: boolean },
): Promise<Record<string, string>> {
  const recorded: Record<string, string> = {};
  // After an incomplete report the notices file may hold text nothing reviewed, so it stays in the review.
  for (const rel of toolPaths(workspace).filter((item) => options.notices || item !== NOTICES_FILE)) {
    const buffer = await readFile(path.join(workspace.path, rel)).catch(() => null);
    if (buffer) recorded[rel] = sha256(buffer);
  }
  return recorded;
}

/** Dependencies an install put in the run directory, kept so each verification need not reinstall. */
/** The home folder of commands in containers, which holds what install fetched. */
export const RUN_HOME = ".rt-home";
const KEPT_IN_RUN = new Set(["node_modules", ".venv", "target", ".gradle", RUN_HOME]);
const RUN_MARKER = ".rt-reviewed-fingerprint";

/**
 * Builds the directory verification runs in from exactly the reviewed files. Anything outside the
 * fingerprint, such as a hand-made package under node_modules, is not there to influence a result.
 * It holds no .git, because that file names the real repository and git on the host obeys what it finds.
 * Installed packages survive only while the code they were installed for is unchanged. Otherwise
 * something an earlier run left there would count as a dependency of code it never saw.
 */
export async function syncRunDirectory(
  workspace: Workspace,
  directory: string,
  options: { provisional?: boolean } = {},
): Promise<TreeReview> {
  await mkdir(directory, { recursive: true });
  const review = await reviewTree(workspace);
  const marker = await readFile(path.join(directory, RUN_MARKER), "utf8").catch(() => "");
  const reusable = options.provisional || marker === review.fingerprint;
  const topLevel = new Set(review.files.map((file) => file.path.split("/")[0]!));
  for (const entry of await readdir(directory)) {
    const target = path.join(directory, entry);
    const info = await lstat(target);
    // Only real directories survive, because a container could leave a link pointing at the host.
    const keep = reusable && KEPT_IN_RUN.has(entry) && info.isDirectory() && !topLevel.has(entry);
    if (!keep) await rm(target, { recursive: true, force: true, maxRetries: 3 });
  }
  const copied = review.files.filter((file) => !file.symlink);
  const folders = new Set(copied.map((file) => path.dirname(path.join(directory, file.path))));
  await mapLimit([...folders], FILE_CONCURRENCY, (folder) => mkdir(folder, { recursive: true }));
  await mapLimit(copied, FILE_CONCURRENCY, async (file) => {
    const buffer = await readFile(path.join(workspace.path, file.path));
    if (sha256(buffer) !== file.hash) {
      throw new TransplantError("workspace_changed", `${file.path} changed during verification setup.`);
    }
    await writeFile(path.join(directory, file.path), buffer);
  });
  // A provisional run never vouches for the packages, so the next full run starts clean.
  await writeFile(path.join(directory, RUN_MARKER), options.provisional ? "provisional" : review.fingerprint);
  return review;
}

/** Writes the base commit's files to a folder. Filters were refused at the start, and no hooks run. */
export async function exportBase(workspace: Workspace, directory: string): Promise<void> {
  await rm(directory, { recursive: true, force: true, maxRetries: 3 });
  await mkdir(directory, { recursive: true });
  const index = path.join(os.tmpdir(), `rt-index-${randomId(8)}`);
  const env = { GIT_INDEX_FILE: index };
  try {
    await gitIn(workspace.gitDir, ["read-tree", workspace.baseSha], { env });
    const prefix = `--prefix=${directory.replaceAll("\\", "/")}/`;
    await gitIn(workspace.gitDir, ["--work-tree=.", "checkout-index", "-a", prefix], { env });
  } finally {
    await rm(index, { force: true }).catch(() => undefined);
  }
}

export async function branchTip(workspace: Workspace): Promise<string> {
  return (await listRefs(workspace.gitDir)).get(`refs/heads/${workspace.branch}`) ?? workspace.baseSha;
}

/** Whether a commit has reached the target's checked-out branch. */
export async function isMerged(target: string, commit: string): Promise<boolean> {
  const result = await gitTarget(target, ["merge-base", "--is-ancestor", commit, "HEAD"], {
    allowFailure: true,
  });
  return result.code === 0;
}

/** Reviewed files whose content a command changed in the run directory. */
export async function modifiedInRun(
  review: TreeReview,
  directory: string,
  skip: (rel: string) => boolean,
): Promise<string[]> {
  const checked = review.files.filter((file) => !file.symlink && !skip(file.path));
  const same = await mapLimit(checked, FILE_CONCURRENCY, async (file) => {
    const buffer = await readFile(path.join(directory, file.path)).catch(() => null);
    return buffer !== null && sha256(buffer) === file.hash;
  });
  return checked.filter((_, index) => !same[index]).map((file) => file.path);
}

/** The name and email the target's own git config gives for commits. */
async function commitIdentity(target: string): Promise<NodeJS.ProcessEnv> {
  const read = async (key: string): Promise<string> =>
    (await gitTarget(target, ["config", key], { allowFailure: true })).stdout.trim();
  const [name, email] = [await read("user.name"), await read("user.email")];
  if (!name || !email) {
    throw new TransplantError("no_identity", "Git has no user.name and user.email set for this repository.");
  }
  return {
    GIT_AUTHOR_NAME: name,
    GIT_AUTHOR_EMAIL: email,
    GIT_COMMITTER_NAME: name,
    GIT_COMMITTER_EMAIL: email,
  };
}

/** CRLF from a Windows checkout becomes LF, as `git add` would do. Files with a lone CR are left alone. */
function withLineFeeds(buffer: Buffer): Buffer {
  const text = buffer.toString("utf8");
  if (isBinary(buffer) || !text.includes("\r\n") || /\r(?!\n)/.test(text)) return buffer;
  return Buffer.from(normalizeNewlines(text));
}

/**
 * Builds the commit from the exact bytes the review read, in a throwaway index. Nothing in the worktree's
 * own index, filters or hooks takes part, so what merges is what was reviewed.
 */
export async function commitReviewed(
  target: string,
  workspace: Workspace,
  review: TreeReview,
  message: string,
  options: { includeRecords: boolean },
): Promise<string> {
  const identity = await commitIdentity(target);
  const base = await listBase(workspace);
  const hashes = new Map(review.files.map((file) => [file.path, file.hash]));
  const autocrlf = await gitTarget(target, ["config", "core.autocrlf"], { allowFailure: true });
  const convertsToLf = ["true", "input"].includes(autocrlf.stdout.trim().toLowerCase());
  const index = path.join(os.tmpdir(), `rt-index-${randomId(8)}`);
  const blob = `${index}.blob`;
  const env = { GIT_INDEX_FILE: index };
  try {
    await gitIn(workspace.gitDir, ["read-tree", workspace.baseSha], { env });
    // Deletions go first, since a file can be replaced by a folder of the same name.
    for (const file of review.changed.filter((item) => item.status === "deleted")) {
      await gitIn(workspace.gitDir, ["update-index", "--force-remove", "--", file.path], { env });
    }
    const written = [...review.changed.filter((file) => file.status !== "deleted")];
    for (const rel of Object.keys(workspace.toolFiles ?? {})) {
      if (options.includeRecords || !rel.startsWith(".transplant/")) {
        written.push({ path: rel, status: "added", symlink: false });
      }
    }
    for (const file of written) {
      if (file.symlink) {
        throw new TransplantError("unsafe_commit", `A symlink cannot be committed this way: ${file.path}`);
      }
      const absolute = path.join(workspace.path, file.path);
      const buffer = await readFile(absolute);
      if (sha256(buffer) !== (hashes.get(file.path) ?? workspace.toolFiles?.[file.path])) {
        throw new TransplantError("stale_review", `${file.path} changed after the report.`);
      }
      const before = base.has(file.path) ? await showBaseFile(workspace, file.path) : null;
      const bytes = convertsToLf || before?.includes("\r") === false ? withLineFeeds(buffer) : buffer;
      await writeFile(blob, bytes);
      const stored = await gitIn(workspace.gitDir, ["hash-object", "-w", "--no-filters", "--", blob]);
      if (stored.stdout.trim() !== gitBlobSha(bytes)) {
        throw new TransplantError("stale_review", `${file.path} could not be stored intact.`);
      }
      const executable = (await lstat(absolute)).mode & 0o111 ? "100755" : "100644";
      // Only a regular file's mode carries over. Reusing a symlink's would turn this file into one.
      const known = base.get(file.path)?.mode;
      const mode = known === "100644" || known === "100755" ? known : executable;
      const entry = `${mode},${stored.stdout.trim()},${file.path}`;
      await gitIn(workspace.gitDir, ["update-index", "--add", "--cacheinfo", entry], { env });
    }
    const tree = (await gitIn(workspace.gitDir, ["write-tree"], { env })).stdout.trim();
    const commit = await gitIn(
      workspace.gitDir,
      ["commit-tree", tree, "-p", workspace.baseSha, "-m", message],
      { env: identity },
    );
    const sha = commit.stdout.trim();
    await gitIn(workspace.gitDir, ["update-ref", `refs/heads/${workspace.branch}`, sha, workspace.baseSha]);
    if (workspace.adminDir) {
      const worktreeIndex = { GIT_INDEX_FILE: path.join(workspace.adminDir, "index") };
      await gitIn(workspace.gitDir, ["read-tree", sha], { env: worktreeIndex });
    }
    return sha;
  } finally {
    await rm(index, { force: true }).catch(() => undefined);
    await rm(blob, { force: true }).catch(() => undefined);
  }
}
