import { type SpawnOptions, spawn, spawnSync } from "node:child_process";
import { TransplantError } from "./errors.js";

export interface ExecResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  truncated: boolean;
  durationMs: number;
}

export interface ExecOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  maxOutputBytes?: number;
  shell?: boolean;
  onOutput?: (chunk: Buffer) => void;
  /** Stops the command and everything it started. */
  signal?: AbortSignal;
}

/**
 * Names code may see while verifying. An allowlist fails safe: a secret under an unusual name stays out,
 * whereas a denylist of names misses DB_PASS, MYSQL_PWD, KUBECONFIG and whatever comes next.
 */
const SAFE_ENV = new Set(
  `PATH Path PATHEXT SystemRoot SYSTEMROOT SystemDrive windir WINDIR ComSpec COMSPEC OS TEMP TMP TMPDIR
  LANG LANGUAGE LC_ALL LC_CTYPE TZ TERM NUMBER_OF_PROCESSORS PROCESSOR_ARCHITECTURE ProgramFiles
  ProgramW6432 CommonProgramFiles ProgramData ALLUSERSPROFILE SHELL USER USERNAME LOGNAME JAVA_HOME
  GOROOT RUSTUP_HOME NVM_DIR NVM_BIN FNM_DIR PYENV_ROOT VIRTUAL_ENV CONDA_PREFIX DOTNET_ROOT
  ANDROID_HOME XDG_RUNTIME_DIR`
    .split(/\s+/)
    .filter(Boolean),
);
const SAFE_PREFIX = /^(ProgramFiles|CommonProgramFiles|LC_)/;

/**
 * Environment for running code that derives from an untrusted source repository. With `home`, tools
 * that look in the home directory for credentials find a throwaway one. This limits what code picks up
 * by accident. It is not a sandbox: the code can still read files and use the network.
 */
export function scrubbedEnv(base: NodeJS.ProcessEnv = process.env, home?: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(base)) {
    if (SAFE_ENV.has(key) || SAFE_PREFIX.test(key)) env[key] = value;
  }
  env.CI = "1";
  if (home) {
    env.HOME = home;
    env.USERPROFILE = home;
    env.APPDATA = home;
    env.LOCALAPPDATA = home;
    env.XDG_CONFIG_HOME = home;
    env.XDG_CACHE_HOME = home;
    const realHome = base.HOME ?? base.USERPROFILE;
    if (realHome && !env.RUSTUP_HOME) env.RUSTUP_HOME = `${realHome}/.rustup`;
  }
  return env;
}

function killTree(pid: number): void {
  try {
    if (process.platform === "win32") {
      spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    } else {
      process.kill(-pid, "SIGKILL");
    }
  } catch {
    // The process already exited.
  }
}

export function exec(command: string, args: string[], options: ExecOptions = {}): Promise<ExecResult> {
  const maxBytes = options.maxOutputBytes ?? 32 * 1024 * 1024;
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const spawnOptions: SpawnOptions = {
      cwd: options.cwd,
      env: options.env ?? process.env,
      shell: options.shell ?? false,
      windowsHide: true,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    };
    const child = spawn(command, args, spawnOptions);
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let captured = 0;
    let timedOut = false;
    let settled = false;
    const finish = (code: number | null): void => {
      if (settled) return;
      settled = true;
      resolve({
        code,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        timedOut,
        truncated: captured >= maxBytes,
        durationMs: Date.now() - started,
      });
    };

    const collect = (sink: Buffer[]) => (chunk: Buffer) => {
      options.onOutput?.(chunk);
      if (captured >= maxBytes) return;
      sink.push(chunk);
      captured += chunk.length;
    };
    child.stdout?.on("data", collect(stdout));
    child.stderr?.on("data", collect(stderr));

    const timer = options.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          if (child.pid) killTree(child.pid);
          // A daemonized grandchild can hold the pipes open after the kill.
          setTimeout(() => finish(null), 3000).unref();
        }, options.timeoutMs)
      : undefined;

    const cancel = (): void => {
      if (child.pid) killTree(child.pid);
      setTimeout(() => finish(null), 3000).unref();
    };
    if (options.signal?.aborted) cancel();
    else options.signal?.addEventListener("abort", cancel, { once: true });

    child.on("error", (error) => {
      if (timer) clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      options.signal?.removeEventListener("abort", cancel);
      finish(code);
    });
  });
}

function gitEnv(extra: NodeJS.ProcessEnv = {}, local = false): NodeJS.ProcessEnv {
  const { HOME, HOMEDRIVE, HOMEPATH, USERPROFILE, XDG_CONFIG_HOME } = process.env;
  const base = local
    ? { ...scrubbedEnv(), HOME, HOMEDRIVE, HOMEPATH, USERPROFILE, XDG_CONFIG_HOME }
    : process.env;
  const env: NodeJS.ProcessEnv = { ...base, GIT_TERMINAL_PROMPT: "0", GIT_LFS_SKIP_SMUDGE: "1" };
  // A partial clone would otherwise reach for its remote, and start a configured program to do it.
  if (local) env.GIT_NO_LAZY_FETCH = "1";
  for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY"]) delete env[key];
  return { ...env, ...extra };
}

export interface GitOptions {
  cwd?: string;
  timeoutMs?: number;
  allowFailure?: boolean;
  env?: NodeJS.ProcessEnv;
  /** For calls that use no network or credentials. They keep only the safe environment. */
  local?: boolean;
}

/** Names the subcommand in errors, skipping options and the values of -c and -C. */
function label(args: string[]): string {
  const command = args.find(
    (arg, index) => !arg.startsWith("-") && !["-c", "-C"].includes(args[index - 1] ?? ""),
  );
  return `git ${command ?? ""}`.trim();
}

export async function git(args: string[], options: GitOptions = {}): Promise<ExecResult> {
  const timeoutMs = options.timeoutMs ?? 120_000;
  const env = gitEnv(options.env, options.local);
  const result = await exec("git", args, { cwd: options.cwd, env, timeoutMs });
  if (result.timedOut) {
    throw new TransplantError("git_timeout", `${label(args)} timed out after ${timeoutMs}ms`);
  }
  if (result.truncated) {
    throw new TransplantError("git_output_too_large", `${label(args)} output exceeded the capture limit.`);
  }
  if (result.code !== 0 && !options.allowFailure) {
    throw new TransplantError(
      "git_failed",
      `${label(args)} failed: ${(result.stderr || result.stdout).trim().slice(0, 800)}`,
    );
  }
  return result;
}
