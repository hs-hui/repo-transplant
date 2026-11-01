import { mkdir, realpath, rename, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Config } from "../config.js";
import { TransplantError } from "../util/errors.js";
import { git } from "../util/exec.js";
import {
  assertSafeRelative,
  pathExists,
  randomId,
  readJson,
  sha256,
  toPosix,
  writeJsonAtomic,
} from "../util/fsx.js";

export interface ParsedSource {
  kind: "remote" | "local";
  url: string;
  host: string;
  owner: string;
  repo: string;
  ref?: string;
  subdir?: string;
  /** Segments after /tree/. Branch names can hold slashes, so the split needs the remote's refs. */
  treePath?: string[];
}

export interface Snapshot {
  id: string;
  root: string;
  analysisRoot: string;
  url: string;
  host: string;
  owner: string;
  repo: string;
  sha: string;
  ref: string;
  subdir?: string;
  fetchedAt: string;
}

const SAFE_SEGMENT = /^[A-Za-z0-9._-]+$/;
const SAFE_REF = /^(?!-)(?!.*\.\.)[A-Za-z0-9._/-]+$/;

function assertRef(ref: string): string {
  if (!SAFE_REF.test(ref)) throw new TransplantError("invalid_ref", `Unsafe git ref: ${ref}`);
  return ref;
}

export function parseSource(input: string, config: Config, allowLocal = false): ParsedSource {
  const value = input.trim();
  if (allowLocal && (path.isAbsolute(value) || /^[a-zA-Z]:[\\/]/.test(value))) {
    return {
      kind: "local",
      url: path.resolve(value),
      host: "local",
      owner: "local",
      repo: path.basename(value),
    };
  }

  const shorthand = value.match(/^([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)$/);
  const scp = value.match(/^git@([^:]+):([^/]+)\/(.+?)(?:\.git)?$/);
  let host: string;
  let owner: string;
  let repo: string;
  let rest: string[] = [];

  if (shorthand) {
    host = "github.com";
    owner = shorthand[1]!;
    repo = shorthand[2]!.replace(/\.git$/, "");
  } else if (scp) {
    host = scp[1]!;
    owner = scp[2]!;
    repo = scp[3]!;
  } else {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new TransplantError("invalid_source", `Not a repository URL: ${value}`);
    }
    if (url.protocol !== "https:" && url.protocol !== "ssh:") {
      throw new TransplantError(
        "invalid_source",
        `Only https and ssh repository URLs are accepted: ${value}`,
      );
    }
    if (url.password || (url.username && url.username !== "git")) {
      throw new TransplantError("invalid_source", "Repository URLs must not embed credentials.");
    }
    const segments = url.pathname.split("/").filter(Boolean);
    if (segments.length < 2) throw new TransplantError("invalid_source", `Not a repository URL: ${value}`);
    host = url.hostname.toLowerCase();
    owner = segments[0]!;
    repo = segments[1]!.replace(/\.git$/, "");
    rest = segments.slice(2);
  }

  if (!config.allowedHosts.includes(host.toLowerCase())) {
    throw new TransplantError(
      "host_not_allowed",
      `Host ${host} is not allowed.`,
      `Allowed hosts: ${config.allowedHosts.join(", ")}. Set RT_ALLOWED_HOSTS to change this.`,
    );
  }
  if (!SAFE_SEGMENT.test(owner) || !SAFE_SEGMENT.test(repo)) {
    throw new TransplantError("invalid_source", `Unsafe repository name: ${owner}/${repo}`);
  }

  const parsed: ParsedSource = {
    kind: "remote",
    url: `https://${host}/${owner}/${repo}.git`,
    host,
    owner,
    repo,
  };
  if ((rest[0] === "tree" || rest[0] === "blob") && rest[1]) {
    parsed.ref = rest[1];
    if (rest.length > 2) {
      parsed.subdir = rest.slice(2).join("/");
      parsed.treePath = rest.slice(1);
    }
  }
  return parsed;
}

async function assertRemoteSize(source: ParsedSource, config: Config): Promise<void> {
  if (source.host !== "github.com") return;
  try {
    const response = await fetch(`https://api.github.com/repos/${source.owner}/${source.repo}`, {
      headers: { accept: "application/vnd.github+json", "user-agent": "repo-transplant-mcp" },
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) return;
    const body = (await response.json()) as { size?: number };
    if (typeof body.size === "number" && body.size / 1024 > config.maxRepoMb) {
      throw new TransplantError(
        "repo_too_large",
        `Repository is about ${Math.round(body.size / 1024)} MB, over the ${config.maxRepoMb} MB limit.`,
        "Raise RT_MAX_REPO_MB if this is intended.",
      );
    }
  } catch (error) {
    if (error instanceof TransplantError) throw error;
    // The size check is best effort. Private repositories and rate limits land here.
  }
}

/** Config applied before any fetched content touches disk, so a hostile repository gets no execution path. */
function hardenedConfig(allowFileProtocol: boolean): [string, string][] {
  return [
    ["core.hooksPath", os.devNull],
    ["core.symlinks", "false"],
    ["core.fsmonitor", "false"],
    ["core.autocrlf", "false"],
    ["core.longpaths", "true"],
    ["protocol.allow", "never"],
    ["protocol.https.allow", "always"],
    ["protocol.ssh.allow", "always"],
    ["protocol.file.allow", allowFileProtocol ? "always" : "never"],
    ["submodule.recurse", "false"],
    ["fetch.recurseSubmodules", "false"],
  ];
}

function snapshotDir(config: Config, source: ParsedSource, sha: string): string {
  const slug = `${source.host}__${source.owner}__${source.repo}`.replace(/[^A-Za-z0-9._-]/g, "_");
  return path.join(config.cacheDir, slug, sha);
}

function snapshotId(source: ParsedSource, sha: string, subdir?: string): string {
  const scope = subdir ? `.${sha256(subdir).slice(0, 8)}` : "";
  return `${source.host}__${source.owner}__${source.repo}@${sha}${scope}`.replace(/[^A-Za-z0-9._@-]/g, "_");
}

/** Finds the longest ref that prefixes a /tree/ path, so /tree/feature/x/src resolves to feature/x. */
async function splitTreePath(source: ParsedSource): Promise<{ ref?: string; subdir?: string }> {
  const segments = source.treePath;
  if (!segments) return { ref: source.ref, subdir: source.subdir };
  const listing = await git(["ls-remote", "--heads", "--tags", "--", source.url], {
    timeoutMs: 60_000,
    allowFailure: true,
  });
  const refs = new Set(
    listing.stdout
      .split("\n")
      .map((line) => line.split("\t")[1]?.replace(/^refs\/(heads|tags)\//, ""))
      .filter(Boolean),
  );
  for (let end = segments.length; end > 0; end--) {
    const ref = segments.slice(0, end).join("/");
    if (refs.has(ref)) return { ref, subdir: segments.slice(end).join("/") || undefined };
  }
  return { ref: source.ref, subdir: source.subdir };
}

async function assertBlobTotal(directory: string, config: Config): Promise<void> {
  const listing = await git(["-C", directory, "ls-tree", "-r", "-l", "FETCH_HEAD"], { timeoutMs: 120_000 });
  let bytes = 0;
  let files = 0;
  for (const line of listing.stdout.split("\n")) {
    const size = Number.parseInt(line.split(/\s+/)[3] ?? "", 10);
    if (Number.isFinite(size)) bytes += size;
    if (line) files++;
  }
  if (bytes / (1024 * 1024) > config.maxRepoMb || files > 500_000) {
    throw new TransplantError(
      "repo_too_large",
      `Checkout would be ${Math.round(bytes / (1024 * 1024))} MB across ${files} files, over the limit.`,
      "Raise RT_MAX_REPO_MB if this is intended.",
    );
  }
}

export async function fetchSnapshot(
  source: ParsedSource,
  config: Config,
  options: { ref?: string; subdir?: string } = {},
): Promise<Snapshot> {
  const fromUrl = options.ref ? { ref: options.ref, subdir: source.subdir } : await splitTreePath(source);
  const ref = assertRef(fromUrl.ref ?? "HEAD");
  const subdir = options.subdir ?? fromUrl.subdir;
  if (subdir) assertSafeRelative(subdir);
  if (source.kind === "remote") await assertRemoteSize(source, config);

  await mkdir(config.cacheDir, { recursive: true });
  const temp = path.join(config.cacheDir, `.tmp-${randomId(6)}`);
  await mkdir(temp, { recursive: true });
  const timeoutMs = config.gitTimeoutMs;

  try {
    await git(["init", "-q", temp]);
    for (const [key, value] of hardenedConfig(source.kind === "local")) {
      await git(["-C", temp, "config", key, value]);
    }
    const remote = source.kind === "local" ? `file://${toPosix(source.url)}` : source.url;
    await git(["-C", temp, "remote", "add", "origin", remote]);
    await git(["-C", temp, "fetch", "--depth=1", "--no-tags", "--no-recurse-submodules", "origin", ref], {
      timeoutMs,
    });
    const sha = (await git(["-C", temp, "rev-parse", "FETCH_HEAD^{commit}"])).stdout.trim();
    await assertBlobTotal(temp, config);
    await git(["-C", temp, "checkout", "-q", "--detach", "FETCH_HEAD"], { timeoutMs });
    await rm(path.join(temp, ".git"), { recursive: true, force: true, maxRetries: 5 });

    const finalDir = snapshotDir(config, source, sha);
    const repoDir = path.join(finalDir, "repo");
    if (await pathExists(repoDir)) {
      await rm(temp, { recursive: true, force: true, maxRetries: 5 });
    } else {
      await mkdir(finalDir, { recursive: true });
      await rename(temp, repoDir);
    }

    if (subdir) {
      const candidate = path.join(repoDir, subdir);
      if (!(await pathExists(candidate))) {
        throw new TransplantError("not_found", `Subdirectory not found in snapshot: ${subdir}`);
      }
      const real = await realpath(candidate);
      if (!real.startsWith((await realpath(repoDir)) + path.sep)) {
        throw new TransplantError("unsafe_path", `Subdirectory escapes the snapshot: ${subdir}`);
      }
    }
    const snapshot: Snapshot = {
      id: snapshotId(source, sha, subdir),
      root: repoDir,
      analysisRoot: subdir ? path.join(repoDir, subdir) : repoDir,
      url: source.kind === "local" ? source.url : source.url.replace(/\.git$/, ""),
      host: source.host,
      owner: source.owner,
      repo: source.repo,
      sha,
      ref,
      subdir,
      fetchedAt: new Date().toISOString(),
    };
    await writeJsonAtomic(path.join(config.cacheDir, "index", `${snapshot.id}.json`), snapshot);
    return snapshot;
  } catch (error) {
    await rm(temp, { recursive: true, force: true, maxRetries: 5 }).catch(() => undefined);
    throw error;
  }
}

export async function loadSnapshot(id: string, config: Config): Promise<Snapshot> {
  if (!/^[A-Za-z0-9._@-]+$/.test(id)) {
    throw new TransplantError("invalid_snapshot", `Invalid snapshot id: ${id}`);
  }
  const file = path.join(config.cacheDir, "index", `${id}.json`);
  if (!(await pathExists(file))) {
    throw new TransplantError("snapshot_not_found", `Unknown snapshot: ${id}`, "Call repo_fetch first.");
  }
  return readJson<Snapshot>(file);
}

export async function remoteHeadSha(url: string, ref: string): Promise<string | null> {
  if (/^[0-9a-f]{40}$/i.test(ref)) return ref.toLowerCase();
  assertRef(ref);
  const result = await git(["ls-remote", "--", url, ref], { timeoutMs: 60_000, allowFailure: true });
  if (result.code !== 0) return null;
  // ls-remote matches ref tails, so refs/heads/a/main must not stand in for main.
  const wanted = new Set([ref, `refs/heads/${ref}`, `refs/tags/${ref}`]);
  for (const line of result.stdout.split("\n")) {
    const [sha, name] = line.split("\t");
    if (sha && name && wanted.has(name)) return sha;
  }
  return null;
}

/** Clones a writable target repository for repo-to-repo transplants. History stays available for branches. */
export async function cloneTarget(source: ParsedSource, config: Config, dest?: string): Promise<string> {
  const directory = dest
    ? path.resolve(dest)
    : path.join(config.targetsDir, `${source.owner}__${source.repo}-${randomId()}`);
  if (await pathExists(directory)) {
    throw new TransplantError("destination_exists", `Destination already exists: ${directory}`);
  }
  await mkdir(path.dirname(directory), { recursive: true });
  // `git -c` applies to this process only, so the writable checkout keeps normal behavior afterwards.
  const configArgs = hardenedConfig(false).flatMap(([key, value]) => ["-c", `${key}=${value}`]);
  await git(
    [...configArgs, "clone", "--filter=blob:none", "--no-recurse-submodules", "--", source.url, directory],
    { timeoutMs: config.gitTimeoutMs },
  );
  return directory;
}
