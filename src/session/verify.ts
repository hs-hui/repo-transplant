import { createWriteStream, existsSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { isLockFile } from "../repo/walk.js";
import { TransplantError } from "../util/errors.js";
import { type ExecResult, exec, scrubbedEnv } from "../util/exec.js";
import { randomId, sha256 } from "../util/fsx.js";
import { sanitizeDisplay } from "../util/text.js";
import type { TransplantPlan } from "./schema.js";
import type { BaselineRun, VerificationRun } from "./store.js";
import { exportBase, modifiedInRun, RUN_HOME, syncRunDirectory, type Workspace } from "./workspace.js";

const NO_TESTS =
  /(no test files found|no tests found|no tests ran|collected 0 items|ran 0 tests|running 0 tests|(?<![\d.,])0 passing|(?<![\d.,])0 tests? (run|executed)|^\D*\btests\s+0\s*$|tests?:\s+0 total|\bno test suites? found)/im;
/** Summaries where every test was skipped. Exit code 0 here means nothing was proven. */
const ALL_SKIPPED =
  /^\s*Tests\s+(?:\d+ (?:skipped|todo)(?: \| )?)+ ?\(\d+\)\s*$|^\s*Tests:\s+(?:\d+ (?:skipped|todo),\s*)+\d+ total\s*$|^[\s=]*\d+ (?:skipped|deselected)(?:, \d+ (?:skipped|deselected|xfailed|xpassed))* in [\d.]+/m;
const NODE_NONE_PASSED = /^[#ℹ]\s*pass 0\s*$/m;
const SOME_TESTS_RAN = /\brunning [1-9]\d* tests?\b|\b[1-9]\d* (tests? )?pass(ed|ing)\b|^[#ℹ]\s*pass [1-9]/im;
const TAIL_BYTES = 6000;
const MAX_LOG_BYTES = 20 * 1024 * 1024;
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "0.0.0.0", "host.docker.internal", ""]);
/** Settings that load code or redirect tooling. A plan cannot set these, however it was approved. */
const FORBIDDEN_ENV =
  /^(NODE_OPTIONS|NODE_PATH|NODE_EXTRA_CA_CERTS|NODE_TLS_REJECT_UNAUTHORIZED|LD_.*|DYLD_.*|PATH|PATHEXT|HOME|USERPROFILE|PYTHON(PATH|STARTUP|HOME|INSPECT)|RUBY(OPT|LIB)|PERL5(OPT|LIB)|BASH_ENV|ENV|ZDOTDIR|GIT_.*|NPM_CONFIG_.*|YARN_.*|PIP_.*|UV_.*|CARGO_.*|RUSTC.*|RUSTUP_.*|_?JAVA_(TOOL_)?OPTIONS|JDK_JAVA_OPTIONS|DOTNET_STARTUP_HOOKS|COR(ECLR)?_.*|COMSPEC|PGSERVICE|PGSERVICEFILE|PGPASSFILE|MYSQL_HOME)$/i;
/** Settings under those prefixes that only tune output or caching. */
const HARMLESS_ENV =
  /^(CARGO_TERM_\w+|CARGO_INCREMENTAL|CARGO_PROFILE_\w+|PIP_NO_\w+|PIP_DISABLE_\w+|PIP_CACHE_DIR|UV_CACHE_DIR|UV_NO_CACHE|UV_NO_PROGRESS|UV_LINK_MODE|NPM_CONFIG_(LOGLEVEL|AUDIT|FUND|PROGRESS))$/i;
const isForbiddenEnv = (name: string): boolean => FORBIDDEN_ENV.test(name) && !HARMLESS_ENV.test(name);
/** Names that hold a connection target, so their plain values are read as hosts. */
const CONNECTION_VARIABLE =
  /(^|_)(HOST|HOSTS|HOSTNAME|SERVER|ADDR|ADDRESS|ENDPOINT|DSN|URL|URI|CONNECTION|BROKERS?)(_|$)|^PGHOST|^DATABASE/i;
const DATABASE_URL =
  /(?:jdbc:)?\b(?:postgres(?:ql)?|mysql|mariadb|mongodb|redis|rediss|amqps?|sqlserver|mssql)(?:\+[a-z0-9_]+)?:\/\/\S+/gi;
const CLI_HOST = /(?:^|\s)(?:-h|--host|--hostname|--server)[=\s]+['"]?([^\s'"]+)/g;
const INLINE_HOST = /(?:^|\s)(?:PGHOST|MYSQL_HOST|DB_HOST|DATABASE_HOST|REDIS_HOST)=['"]?([^\s'"]+)/g;
/** Database clients also take -hHOST, which other tools use for flags such as `df -h`, so only these count. */
const DB_CLI_HOST =
  /\b(?:psql|pg_dump|pg_restore|mysql|mysqldump|mariadb|redis-cli|mongosh?)\b[^\n;&|]*?\s-h([^\s'"=]+)/g;
const SQLCMD_HOST = /\bsqlcmd\b[^\n;&|]*?\s-S\s*['"]?([^\s'"]+)/g;
const KEYWORD_HOST = /(?:^|[\s'"])(?:host|hostaddr)\s*=\s*['"]?([^\s'";&]+)/gi;
/** A variable set in the command text. The env field is checked by name, so this has to be too. */
const INLINE_ASSIGNMENT = /(?:^|[\s;&|(])(?:export\s+|set\s+|env\s+|\$env:)?([A-Za-z_]\w*)=/g;

const SERVICE_READY_ATTEMPTS = 60;
const MAX_FAILURES = 200;

export interface CommandSummary extends VerificationRun {
  output_tail: string;
}

export type VerifiedCommand = TransplantPlan["verification"]["commands"][number];
type Command = VerifiedCommand;

function stripPort(raw: string): string {
  const host = raw.trim();
  const bracket = host.match(/^\[([^\]]+)\]/);
  if (bracket) return bracket[1]!.toLowerCase();
  // Two colons or more is a bare IPv6 address, not host:port.
  if ((host.match(/:/g) ?? []).length > 1) return host.toLowerCase();
  return host.replace(/:\d*$/, "").toLowerCase();
}

function decoded(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** Pulls every host out of a URL, a multi-host list, a driver string or a keyword connection string. */
function hostsIn(rawValue: string, isConnection: boolean): string[] {
  const value = decoded(rawValue);
  const hosts: string[] = [];
  for (const match of value.matchAll(/(?:^|[^:/])\/\/([^/?#\s]*)/g)) {
    const authority = match[1]!.slice(match[1]!.lastIndexOf("@") + 1);
    hosts.push(...authority.split(",").map(stripPort));
  }
  for (const match of value.matchAll(/:\/\/([^/?#\s]*)/g)) {
    const authority = match[1]!.slice(match[1]!.lastIndexOf("@") + 1);
    hosts.push(...authority.split(",").map(stripPort));
  }
  for (const match of value.matchAll(/\btcp\(([^)]*)\)/gi)) hosts.push(stripPort(match[1]!));
  for (const match of value.matchAll(
    /(?:^|[?&;\s])(?:host|hostaddr|server|data source|addr)\s*=\s*([^&;\s]+)/gi,
  )) {
    hosts.push(...match[1]!.split(",").map(stripPort));
  }
  if (
    hosts.length === 0 &&
    isConnection &&
    !/^(file:|sqlite:|:memory:|\.{0,2}[/\\]|[a-zA-Z]:[/\\])/.test(value)
  ) {
    const first = value.split(/[/?\s]/)[0] ?? "";
    hosts.push(...first.split(",").map((item) => stripPort(item.slice(item.lastIndexOf("@") + 1))));
  }
  return hosts;
}

/**
 * Rejects connection targets other than this machine, and settings that would load foreign code.
 * This catches mistakes. It is a text check, so it cannot stop a command built to evade it.
 */
export function assertLocalEnv(command: Command, services: string[] = []): void {
  const refuse = (detail: string): never => {
    throw new TransplantError(
      "non_local_env",
      `${command.name}: ${detail}.`,
      "Verification commands may reach local services only. Run migrations against remote databases yourself.",
    );
  };
  // A variable in the text is judged where it is set, which the env check covers.
  const isLocal = (host: string): boolean =>
    LOCAL_HOSTS.has(host) || host.startsWith("/") || host.startsWith("$") || services.includes(host);
  for (const [key, value] of Object.entries(command.env)) {
    if (isForbiddenEnv(key)) {
      throw new TransplantError("forbidden_env", `${command.name}: ${key} cannot be set by a plan.`);
    }
    const remote = hostsIn(value, CONNECTION_VARIABLE.test(key)).find((host) => !isLocal(host));
    if (remote) refuse(`${key} points at ${remote}`);
  }
  const text = command.command;
  for (const match of text.matchAll(INLINE_ASSIGNMENT)) {
    if (isForbiddenEnv(match[1]!)) {
      throw new TransplantError("forbidden_env", `${command.name}: ${match[1]} cannot be set by a plan.`);
    }
  }
  for (const url of text.match(DATABASE_URL) ?? []) {
    const remote = hostsIn(url, true).find((host) => !isLocal(host));
    if (remote) refuse(`the command connects to ${remote}`);
  }
  for (const pattern of [CLI_HOST, INLINE_HOST, DB_CLI_HOST, SQLCMD_HOST, KEYWORD_HOST]) {
    for (const match of text.matchAll(pattern)) {
      const host = stripPort(match[1]!);
      if (!isLocal(host)) refuse(`the command connects to ${host}`);
    }
  }
}

/** Subcommands that run package scripts, for the tools with a flag to stop them. */
const INSTALL_VERBS: Record<string, string[]> = {
  npm: ["install", "i", "ci", "add", "it", "cit", "install-test", "install-ci-test", "rebuild"],
  pnpm: ["install", "i", "add", "rebuild"],
  bun: ["install", "i", "add"],
  yarn: ["install", "add"],
};
const VALUE_FLAGS = new Set(["--prefix", "-w", "--workspace", "--filter", "-F", "-C", "--dir", "--cwd"]);

/** Whether a command would run package install scripts. Each step of a chain is judged alone. */
export function runsInstallScripts(command: string): boolean {
  return command.split(/&&|\|\||[;|\n]/).some((step) => {
    const words = step.trim().split(/\s+/);
    const at = words.findIndex((word) => Object.hasOwn(INSTALL_VERBS, word));
    if (at === -1) return false;
    let index = at + 1;
    while (words[index]?.startsWith("-")) index += VALUE_FLAGS.has(words[index]!) ? 2 : 1;
    const tool = words[at]!;
    const verb = words[index];
    // A bare `yarn` installs.
    if (!(verb === undefined ? tool === "yarn" : INSTALL_VERBS[tool]!.includes(verb))) return false;
    const flag = words.filter((word) => /^--ignore-scripts(=|$)/.test(word)).at(-1);
    return flag === undefined || flag === "--ignore-scripts=false";
  });
}

const SHELL_BUILTIN = /^(cd|echo|test|true|false|export|set|exit|\[|:|if|for|while|then|do|done|fi)$/;

function onPath(tool: string, env: NodeJS.ProcessEnv): boolean {
  const isWindows = process.platform === "win32";
  const directories = (env.PATH ?? env.Path ?? "").split(path.delimiter).filter(Boolean);
  const extensions = isWindows ? ["", ...(env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";")] : [""];
  return directories.some((directory) =>
    extensions.some((extension) => existsSync(path.join(directory, `${tool}${extension}`))),
  );
}

/** Programs the plan's commands need that this machine does not have, found before anyone approves it. */
export function missingTools(plan: TransplantPlan, env: NodeJS.ProcessEnv = process.env): string[] {
  if (plan.verification.docker_image) return onPath("docker", env) ? [] : ["docker"];
  const tools = new Set<string>();
  for (const { command } of plan.verification.commands) {
    for (const part of command.split(/&&|\|\||(?<![>&\d])&(?!>)|\||;|\n/)) {
      const words = part.replace(/^[\s(]+|[\s)]+$/g, "").split(/\s+/);
      const tool = words.find((word) => !/^[A-Za-z_]\w*=|^-/.test(word) && word !== "env");
      // A path is a file the checks create, such as a virtual environment's own python.
      if (tool && !/[\\/]/.test(tool) && !SHELL_BUILTIN.test(tool) && /^[\w.+-]+$/.test(tool))
        tools.add(tool);
    }
  }
  return [...tools].filter((tool) => !onPath(tool, env)).sort();
}

/** Docker can be installed and still not running, which would only show once checks start. */
export async function dockerRunning(): Promise<boolean> {
  const result = await exec("docker", ["version", "--format", "{{.Server.Version}}"], {
    timeoutMs: 10_000,
  }).catch(() => null);
  return result?.code === 0;
}

export function dockerArgs(
  image: string,
  workspace: string,
  command: Command,
  name = "rt-verify",
  network = "none",
): string[] {
  const args = [
    "run",
    "--rm",
    "--init",
    `--name=${name}`,
    "--cap-drop=ALL",
    "--security-opt=no-new-privileges",
    "--pids-limit=2048",
    "--memory=4g",
    `--network=${command.kind === "install" ? "bridge" : network}`,
    "-v",
    `${workspace}:/work`,
    "-w",
    "/work",
    "-e",
    "CI=1",
  ];
  // With every capability dropped, root in a container cannot write to a folder this user owns, and
  // files it did write could not be deleted here. So on Linux and macOS commands run as this user.
  const owner = process.getuid?.();
  if (owner) args.push(`--user=${owner}:${process.getgid?.()}`);
  // Each command gets a new container, and only install has network. Caches live in the mounted folder
  // so what install fetched is still there for the commands after it.
  args.push("-e", `HOME=/work/${RUN_HOME}`);
  args.push("-e", `GOPATH=/work/${RUN_HOME}/go`, "-e", `CARGO_HOME=/work/${RUN_HOME}/cargo`);
  for (const [key, value] of Object.entries(command.env)) args.push("-e", `${key}=${value}`);
  args.push(image, "sh", "-c", command.command);
  return args;
}

interface RunContext {
  logPath: string;
  dockerImage?: string;
  network?: string;
  runDir: string;
  homeDir: string;
  signal?: AbortSignal;
}

type Service = TransplantPlan["verification"]["services"][number];

interface RunningServices {
  network?: string;
  containers: string[];
}

const docker = (args: string[], timeoutMs = 300_000, signal?: AbortSignal): Promise<ExecResult> =>
  exec("docker", args, { timeoutMs, signal, maxOutputBytes: 1024 * 1024 });

/** What is running now. Killing the docker client leaves a container running, so a shutdown stops these by name. */
const activeContainers = new Set<string>();
const activeNetworks = new Set<string>();

/** Stops every container and network this process started. A hard kill or a crash never reaches this. */
export async function stopContainers(): Promise<void> {
  const containers = [...activeContainers];
  const networks = [...activeNetworks];
  await Promise.all(containers.map((name) => docker(["rm", "-f", name], 10_000).catch(() => undefined)));
  await Promise.all(networks.map((name) => docker(["network", "rm", name], 10_000).catch(() => undefined)));
}

async function stopServices(running: RunningServices): Promise<void> {
  for (const name of running.containers) {
    await docker(["rm", "-f", name], 30_000).catch(() => undefined);
    activeContainers.delete(name);
  }
  if (running.network) {
    await docker(["network", "rm", running.network], 30_000).catch(() => undefined);
    activeNetworks.delete(running.network);
  }
}

/** Waits, and stops waiting as soon as the run is cancelled. */
function pause(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const done = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    if (signal?.aborted) done();
    else signal?.addEventListener("abort", done, { once: true });
  });
}

/** Starts services on an internal network, which reaches other containers but not the internet. */
export async function startServices(services: Service[], signal?: AbortSignal): Promise<RunningServices> {
  const running: RunningServices = { containers: [] };
  if (services.length === 0) return running;
  const id = randomId(6);
  try {
    const network = `rt-net-${id}`;
    const created = await docker(["network", "create", "--internal", network], 60_000, signal);
    stopIfCancelled(signal);
    if (created.code !== 0) throw new Error(created.stderr.trim());
    running.network = network;
    activeNetworks.add(network);
    for (const service of services) {
      const name = `rt-service-${id}-${service.name}`;
      const env = Object.entries(service.env).flatMap(([key, value]) => ["-e", `${key}=${value}`]);
      const flags = ["--security-opt=no-new-privileges", "--pids-limit=1024", "--memory=2g"];
      const args = ["run", "-d", "--rm", `--name=${name}`, `--network=${network}`, ...flags];
      // The name is claimed first, since a cancelled `docker run -d` can still leave the container behind.
      running.containers.push(name);
      activeContainers.add(name);
      const started = await docker(
        [...args, `--network-alias=${service.name}`, ...env, service.image],
        300_000,
        signal,
      );
      stopIfCancelled(signal);
      if (started.code !== 0) throw new Error(`${service.name}: ${started.stderr.trim().slice(0, 400)}`);
      let ready = false;
      for (let attempt = 0; attempt < SERVICE_READY_ATTEMPTS && !ready; attempt++) {
        const probe = await docker(["exec", name, "sh", "-c", service.ready_command], 15_000, signal);
        stopIfCancelled(signal);
        ready = probe.code === 0;
        if (!ready) await pause(1000, signal);
        stopIfCancelled(signal);
      }
      if (!ready) throw new Error(`${service.name} did not become ready.`);
    }
    return running;
  } catch (error) {
    await stopServices(running);
    if (error instanceof TransplantError) throw error;
    throw new TransplantError("service_failed", `Could not start a verification service: ${String(error)}`);
  }
}

async function runOne(command: Command, context: RunContext): Promise<ExecResult> {
  const log = createWriteStream(context.logPath, { mode: 0o600 });
  log.write(`$ ${command.command}\n`);
  let logged = 0;
  const onOutput = (chunk: Buffer): void => {
    if (logged < MAX_LOG_BYTES) log.write(chunk);
    logged += chunk.length;
  };
  try {
    const timeoutMs = command.timeout_s * 1000;
    if (context.dockerImage) {
      await mkdir(path.join(context.runDir, RUN_HOME), { recursive: true });
      const name = `rt-verify-${randomId(6)}`;
      const args = dockerArgs(context.dockerImage, context.runDir, command, name, context.network);
      const { signal } = context;
      activeContainers.add(name);
      try {
        const result = await exec("docker", args, {
          timeoutMs,
          onOutput,
          signal,
          maxOutputBytes: 1024 * 1024,
        });
        // Killing the client leaves the container running, so stop it by name.
        if (result.timedOut || signal?.aborted) {
          await exec("docker", ["kill", name], { timeoutMs: 15_000 }).catch(() => undefined);
        }
        return result;
      } finally {
        activeContainers.delete(name);
      }
    }
    await mkdir(context.homeDir, { recursive: true });
    return await exec(command.command, [], {
      cwd: context.runDir,
      env: { ...scrubbedEnv(process.env, context.homeDir), ...command.env },
      shell: true,
      timeoutMs,
      onOutput,
      signal: context.signal,
      maxOutputBytes: 1024 * 1024,
    });
  } finally {
    await new Promise((resolve) => log.end(resolve));
  }
}

function stopIfCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new TransplantError("cancelled", "Cancelled. Nothing from this run counts.");
}

export function classifyRun(
  command: Command,
  result: Pick<ExecResult, "code" | "timedOut">,
  output: string,
  changed: boolean,
): VerificationRun["status"] {
  if (result.timedOut) return "timed_out";
  if (result.code !== 0) return "failed";
  // Results describe the code that ran, so a command that rewrites tracked files proves nothing.
  if (changed && command.kind !== "install") return "modified_files";
  const isTest = command.kind === "test" || command.kind === "e2e";
  if (!isTest) return "passed";
  const plain = stripAnsi(output);
  // `go test` prints "ok" with [no tests to run] for a package whose filter or test file matched nothing.
  const goRan = /^ok\s(?!.*\[no tests to run\])/m.test(plain);
  const goWithoutTests = /\[no test files\]|\[no tests to run\]/.test(plain) && !goRan;
  // Cargo prints "running 0 tests" for each target without tests, beside the ones that have them.
  const noTests = NO_TESTS.test(plain) && !SOME_TESTS_RAN.test(plain);
  const cargoResults = plain.match(/^test result: .*$/gm) ?? [];
  const cargoNonePassed = cargoResults.length > 0 && cargoResults.every((line) => /\b0 passed\b/.test(line));
  const goSkipped = /^\s*--- SKIP: /m.test(plain) && !/^\s*--- PASS: /m.test(plain);
  const unittest = plain.match(/^Ran (\d+) tests? in [\s\S]*?^OK \(skipped=(\d+)\)\s*$/m);
  const unittestSkipped = unittest !== null && unittest[1] === unittest[2];
  const skipped =
    goSkipped ||
    unittestSkipped ||
    (!SOME_TESTS_RAN.test(plain) && (ALL_SKIPPED.test(plain) || NODE_NONE_PASSED.test(plain)));
  return noTests || goWithoutTests || cargoNonePassed || skipped ? "no_tests_ran" : "passed";
}

export const stripAnsi = (text: string): string => text.replace(ANSI, "");

const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");
const FAILURE_LINES = [
  /^FAILED (\S+)/gm,
  /^\s*FAIL\s+(.+ > .+?)\s*$/gm,
  /^\s*[×✕✗✖]\s+(.+?)(?:\s+\(?\d+(?:\.\d+)?\s*m?s\)?)?\s*$/gm,
  // Failures that are not a single test. Missing one of these would let a new one pass as old.
  /^ERROR (\S+\.\w\S*)/gm,
  /^FAIL\s+(\S+)\s+\[(?:build|setup) failed\]/gm,
  /^\s*FAIL\s+(\S+\.\w+)(?:\s+\[.*\])?\s*$/gm,
  /^panic: (.+)$/gm,
];

/**
 * Go names a failure only by its function, and prints the package once that package has finished. Names
 * are qualified with it, so the same name failing in another package is not the same failure.
 */
function goFailures(plain: string): string[] {
  const names: string[] = [];
  let pending: string[] = [];
  for (const line of plain.split("\n")) {
    const failed = line.match(/^\s*--- FAIL: (\S+)/);
    if (failed) pending.push(failed[1]!);
    const finished = line.match(/^FAIL\s+(\S+)\s+(?:\d[\d.]*s|\(cached\))\s*$/);
    if (finished) {
      names.push(...pending.map((name) => `${finished[1]}/${name}`));
      pending = [];
    }
  }
  return [...names, ...pending];
}

/** Test names a runner reports as failed. An empty list means the output could not be read that way. */
export function failingTests(output: string): string[] {
  const plain = stripAnsi(output);
  const names = [
    ...goFailures(plain),
    ...FAILURE_LINES.flatMap((pattern) => [...plain.matchAll(pattern)].map((match) => match[1]!)),
  ].map(sanitizeDisplay);
  const tests = names.filter((name) => name !== "failing tests:");
  return [...new Set(tests)].sort().slice(0, MAX_FAILURES);
}

const NARROWING =
  /\s(-run|-k|-t|--grep|--testNamePattern|--filter|--only|--testPathPattern|--tests|-Dtest)[\s=]/;
const TEST_RUNNER =
  /(?:^|[\s/])(pytest|go test|vitest(?: run)?|jest|rspec|phpunit|cargo test|npx vitest(?: run)?|playwright test|manage\.py test|(?:npm|pnpm|yarn)(?: run)? test(?::\w+)?(?: --)?)\s+(.*)$/;

/** Identifies a command's whole output, ignoring what differs between runs: folder, timings and hashes. */
export function failureSignature(output: string, directory: string): string {
  const lines = output
    .replace(ANSI, "")
    .replaceAll("\\", "/")
    .replaceAll(directory.replaceAll("\\", "/"), "")
    .split("\n")
    .map((line) => line.replace(/[0-9a-f]{7,}|\d+/gi, "#").trim())
    .filter(Boolean);
  return sha256(lines.join("\n"));
}

const VALUE_OPTION = /^(-c|--config|--rootdir|-o|-p|-timeout|-count|--reporter)$/;
const WHOLE_SUITE = /(^|\/)(\.\.\.|tests?\/?|specs?\/?|__tests__\/?)$/;

/** A path after the test runner limits it to that folder or file. `./...` and `tests/` mean everything. */
function namesPaths(command: string): boolean {
  return command.split(/&&|;/).some((part) => {
    const words = part.match(TEST_RUNNER)?.[2]?.split(/\s+/) ?? [];
    return words.some(
      (word, index) =>
        !word.startsWith("-") &&
        !VALUE_OPTION.test(words[index - 1] ?? "") &&
        !WHOLE_SUITE.test(word) &&
        /[\\/]|\.\w+$/.test(word),
    );
  });
}

/** Test commands that run only part of a suite. A person should know that when reading a pass. */
export function narrowedChecks(plan: TransplantPlan): string[] {
  return plan.verification.commands
    .filter((item) => ["test", "e2e"].includes(item.kind))
    .filter((item) => NARROWING.test(` ${item.command}`) || namesPaths(item.command))
    .map((item) => item.command);
}

/** A plan that changes UI files and has no browser run leaves the page itself unchecked. */
export function needsBrowserCheck(plan: Pick<TransplantPlan, "files" | "verification">): boolean {
  const changesUi = plan.files.some(
    (file) => /\.(tsx|jsx|vue|svelte)$/.test(file.path) && !/\.(test|spec|stories)\./.test(file.path),
  );
  return changesUi && !plan.verification.commands.some((item) => item.kind === "e2e");
}

/** Runs the plan's commands on the untouched base commit. */
export async function runBaseline(options: VerifyOptions): Promise<BaselineRun[]> {
  const { plan, workspace, logDir, runRoot } = options;
  const dockerImage = plan.verification.docker_image;
  const services = plan.verification.services;
  await mkdir(logDir, { recursive: true });
  const runDir = path.join(runRoot, "base");
  await exportBase(workspace, runDir);
  const names = services.map((service) => service.name);
  for (const command of plan.verification.commands) assertLocalEnv(command, names);
  const running = await startServices(services, options.signal);
  const results: BaselineRun[] = [];
  try {
    for (const command of plan.verification.commands) {
      const logPath = path.join(logDir, `${Date.now()}-baseline-${command.name}.log`);
      stopIfCancelled(options.signal);
      const context = {
        logPath,
        dockerImage,
        network: running.network,
        runDir,
        homeDir: path.join(runRoot, "home"),
        signal: options.signal,
      };
      const result = await runOne(command, context);
      stopIfCancelled(options.signal);
      const output = await readFile(logPath, "utf8");
      results.push({
        name: command.name,
        status: classifyRun(command, result, output, false),
        failures: failingTests(output),
        signature: failureSignature(output, runDir),
      });
    }
  } finally {
    await stopServices(running);
  }
  return results;
}

export interface VerifyOptions {
  plan: TransplantPlan;
  workspace: Workspace;
  logDir: string;
  runRoot: string;
  only?: string[];
  continueOnFailure?: boolean;
  /** Reuses installed packages and skips install commands. Such a run cannot count as evidence. */
  provisional?: boolean;
  baseline?: BaselineRun[];
  signal?: AbortSignal;
}

/**
 * Runs only commands from the approved plan, in a directory built from the reviewed files, and
 * records each result against that exact set of files.
 */
export async function runVerification(options: VerifyOptions): Promise<CommandSummary[]> {
  const { plan, workspace, logDir, runRoot } = options;
  const commands = plan.verification.commands.filter(
    (item) =>
      (!options.only || options.only.includes(item.name)) &&
      !(options.provisional && item.kind === "install"),
  );
  for (const name of options.only ?? []) {
    if (!plan.verification.commands.some((item) => item.name === name)) {
      throw new TransplantError(
        "unknown_command",
        `Not in the approved plan: ${name}`,
        "Only approved commands can run.",
      );
    }
  }
  await mkdir(logDir, { recursive: true });
  const dockerImage = plan.verification.docker_image;
  const runDir = path.join(runRoot, "work");
  const review = await syncRunDirectory(workspace, runDir, { provisional: options.provisional });
  const services = plan.verification.services;
  for (const command of commands)
    assertLocalEnv(
      command,
      services.map((service) => service.name),
    );

  const results: CommandSummary[] = [];
  const running = await startServices(
    commands.some((item) => item.kind !== "install") ? services : [],
    options.signal,
  );
  try {
    for (const command of commands) {
      stopIfCancelled(options.signal);
      const logPath = path.join(logDir, `${Date.now()}-${command.name}.log`);
      const result = await runOne(command, {
        logPath,
        dockerImage,
        network: running.network,
        runDir,
        homeDir: path.join(runRoot, "home"),
        signal: options.signal,
      });
      stopIfCancelled(options.signal);
      const output = await readFile(logPath, "utf8");
      const modified = await modifiedInRun(review, runDir, isLockFile);
      const failures = failingTests(output);
      const before = options.baseline?.find((item) => item.name === command.name);
      let status = classifyRun(command, result, output, modified.length > 0);
      // A failure the base commit already has is reported, not blamed on this work. A test run must name
      // what failed, since output that names nothing proves nothing. Any other command counts
      // only if its whole output matches the base, since a new error anywhere changes that.
      const isTest = command.kind === "test" || command.kind === "e2e";
      const sameTests =
        failures.length > 0 &&
        failures.length < MAX_FAILURES &&
        failures.every((name) => before?.failures.includes(name));
      const hasOutput = output.trim().includes("\n");
      const sameOutput = !isTest && hasOutput && before?.signature === failureSignature(output, runDir);
      if (status === "failed" && before?.status === "failed" && (sameTests || sameOutput)) {
        status = "known_failures";
      }
      results.push({
        name: command.name,
        command: command.command,
        kind: command.kind,
        status,
        failures,
        exit_code: result.code,
        duration_ms: result.durationMs,
        fingerprint: review.fingerprint,
        log_path: logPath,
        isolation: dockerImage ? "docker" : "host",
        at: new Date().toISOString(),
        output_tail: sanitizeDisplay(output.slice(-TAIL_BYTES)),
      });
      if (status !== "passed" && status !== "known_failures" && !options.continueOnFailure) break;
    }
  } finally {
    await stopServices(running);
  }
  return results;
}
