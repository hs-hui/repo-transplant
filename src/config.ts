import os from "node:os";
import path from "node:path";

export interface Config {
  home: string;
  cacheDir: string;
  sessionsDir: string;
  targetsDir: string;
  allowedHosts: string[];
  maxRepoMb: number;
  gitTimeoutMs: number;
  maxFileBytes: number;
  maxOutputChars: number;
  /** How often long tools report progress, which keeps clients with short timeouts from giving up. */
  heartbeatMs: number;
  requireDialog: boolean;
  /** Lets overrides and accepted high findings rest on the agent's word when no dialog is available. */
  allowAttested: boolean;
  /** Where worktrees go. Unset keeps them inside the project, where agents can edit without prompts. */
  worktreeRoot?: string;
}

function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const home = path.resolve(env.RT_HOME ?? path.join(os.homedir(), ".repo-transplant"));
  return {
    home,
    cacheDir: path.join(home, "cache"),
    sessionsDir: path.join(home, "sessions"),
    targetsDir: path.join(home, "targets"),
    allowedHosts: (env.RT_ALLOWED_HOSTS ?? "github.com")
      .split(",")
      .map((host) => host.trim().toLowerCase())
      .filter(Boolean),
    maxRepoMb: positiveInt(env.RT_MAX_REPO_MB, 2048),
    gitTimeoutMs: positiveInt(env.RT_GIT_TIMEOUT_MS, 300_000),
    maxFileBytes: positiveInt(env.RT_MAX_FILE_BYTES, 1_048_576),
    maxOutputChars: positiveInt(env.RT_MAX_OUTPUT_CHARS, 60_000),
    heartbeatMs: 15_000,
    requireDialog: env.RT_REQUIRE_DIALOG === "1",
    allowAttested: env.RT_ALLOW_ATTESTED === "1",
    worktreeRoot: env.RT_WORKTREE_ROOT ? path.resolve(env.RT_WORKTREE_ROOT) : undefined,
  };
}
