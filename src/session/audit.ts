import { readFile } from "node:fs/promises";
import path from "node:path";
import { type LicenseReport, resolveExpression } from "../analysis/license.js";
import {
  type Dependency,
  isManifest,
  isRequirementsFile,
  parseManifest,
  parseToml,
} from "../analysis/manifests.js";
import { scanLockfile, scanPackageScripts, scanText } from "../analysis/security.js";
import { isAssetExtension, isLockFile } from "../repo/walk.js";
import { canonicalJson, parseJsonc, resolveInside, sha256 } from "../util/fsx.js";
import type { TransplantPlan } from "./schema.js";
import type { AuditFinding } from "./store.js";
import { type FileContent, NOTICES_FILE, reviewTree, showBaseFile, type Workspace } from "./workspace.js";

/** The file a source reference names, without a `#anchor` or `:line` suffix. */
export const sourcePath = (ref: string): string => ref.replace(/\\/g, "/").replace(/(?:[#:][\w-]+)+$/, "");

/** Paths that change what runs on a developer's machine or in CI rather than what the product does. */
export const SENSITIVE_PATH =
  /(^|\/)(\.github\/workflows\/|\.gitlab-ci\.yml|\.circleci\/|CLAUDE\.md|AGENTS\.md|GEMINI\.md|\.cursorrules|\.clinerules|\.mcp\.json|\.claude\/|\.cursor\/|\.vscode\/|\.devcontainer\/|\.husky\/|\.npmrc|\.yarnrc|\.yarn\/|\.pnpmfile\.c?js|pnpm-workspace\.yaml|bunfig\.toml|\.pypirc|pip\.conf|setup\.py|\.gitattributes|Dockerfile|\.cargo\/|build\.rs|rust-toolchain|go\.work|Directory\.(Build|Packages)\.|nuget\.config|global\.json|\.mvn\/|settings\.gradle|gradle\.properties|gradle\/wrapper\/|[^/]*\.versions\.toml|\.bundle\/)/i;

const DESTRUCTIVE_SQL =
  /\b(DROP\s+(TABLE|COLUMN|SCHEMA|DATABASE|INDEX)|TRUNCATE\s+(TABLE\s+)?\w|ALTER\s+TABLE\s+\S+\s+DROP|DELETE\s+FROM\s+\w+)/i;
const MIGRATION_DESTRUCTIVE =
  /\b(op\.drop_(table|column)|remove_column|drop_table|dropTable|dropColumn|DropTable|DropColumn|migrations\.(DeleteModel|RemoveField))\b/;
const MIGRATION_FILE =
  /(^|\/)(migrations?|alembic\/versions|db\/migrate|database\/migrations|prisma\/migrations|drizzle)\/|\.sql$/;
const ROLLBACK_FILE = /(^|[._-])(down|rollback|revert)([._-]|$)/i;
const AUTH_WEAKENING =
  /\b(verify\s*[:=]\s*(false|False)|rejectUnauthorized\s*:\s*false|csrf_exempt|@AllowAnonymous|\[AllowAnonymous\]|skip_before_action\s+:(authenticate|verify_authenticity)|cors\(\s*\{[^}]{0,400}?\borigin\s*:\s*(true|['"`]\*['"`])|Access-Control-Allow-Origin['"`]?\s*[:,]\s*['"`]\*)/;
const DESTRUCTIVE_ACROSS_LINES = new RegExp(DESTRUCTIVE_SQL.source, "gi");
const WEAKENING_ACROSS_LINES = new RegExp(AUTH_WEAKENING.source, "g");
const ENV_REFERENCE =
  /\b(?:process\.env\.|process\.env\[['"`]|import\.meta\.env\.|os\.environ\[['"]|os\.environ\.get\(['"]|os\.getenv\(['"]|os\.Getenv\("|ENV\[['"]|ENV\.fetch\(['"]|System\.getenv\(")([A-Z][A-Z0-9_]+)/g;
const AMBIENT_ENV = new Set([
  "NODE_ENV",
  "CI",
  "PORT",
  "HOME",
  "PATH",
  "DEBUG",
  "BASE_URL",
  "DEV",
  "PROD",
  "MODE",
  "SSR",
]);
/** Requirements options that only tune an install. Every other option can change where packages come from. */
const HARMLESS_PIP_OPTION =
  /^(--hash|--no-binary|--only-binary|--prefer-binary|--require-hashes|--pre\b|(-r|--requirement|-c|--constraint)[=\s]*(?!\S*:\/\/)\S)/;
/** npm also reads user/repo and scp-style git addresses, in any case, and npm: installs another package. */
const REMOTE_SPECIFIER =
  /^(https?:|git\+|git:|github:|gitlab:|bitbucket:|gist:|file:|link:|ssh:|npm:|portal:|patch:|[\w.-]+@[\w.-]+:|[\w.-]+\/[\w.-])|@\s*(https?|git\+)/i;
const SKIPPED_TEST =
  /\b(?:it|test|describe|suite)\.(?:skip|todo)\b|\bx(?:it|describe|test)\s*\(|\bt\.Skip(?:f|Now)?\(|@pytest\.mark\.(?:skip|xfail)|@unittest\.skip|@(?:Ignore|Disabled)\b|#\[ignore\]/;
const CHECK_WINDOW = 4000;
const DEPENDENCY_TOKEN =
  /^(?:gem\s+|implementation\s*\(?\s*|api\s*\(?\s*|compileOnly\s*\(?\s*|runtimeOnly\s*\(?\s*|testImplementation\s*\(?\s*|require\s+)?['"]?([@\w./:-]+)['"]?(?:\[[^\]]*\])?\s*(?:[=<>~!^,:]|\sv?\d|$)/;
const ENV_TEMPLATE_LINE = /^\s*(#.*|(export\s+)?[A-Z][A-Z0-9_]*=[^()`;{}]*)?$/;
const YARN_LOCK_LINE = /^(#.*|"?[@\w][^()`;]*:|\s+"?[@\w./-]+"?(:| "?[^()`;]*"?)\s*|\s+[@\w"][^()`;]*:|)$/;
const CALL_LIKE = /(^|[\s;(=])[A-Za-z_$][\w$.]*\(/;
const CHECK_STEP = 3000;
/** Dependency-related fields that change what runs, even in a package.json the plan lists. */
const SENSITIVE_PACKAGE_FIELDS = ["overrides", "resolutions", "pnpm", "bin", "main", "exports"];

/** These leave the review blind, so fixing them is the only way forward. */
const NOT_ACCEPTABLE = new Set([
  "repository.branch_moved",
  "repository.git_link_changed",
  "repository.git_state_changed",
  "repository.index_changed",
  "repository.ref_shadowing",
]);

const severityOf = (severity: string): AuditFinding["severity"] =>
  severity === "critical" || severity === "high" ? "high" : "medium";

function makeFinding(
  rule: string,
  severity: AuditFinding["severity"],
  file: string | null,
  line: number | null,
  message: string,
): AuditFinding {
  return { id: sha256(`${rule}|${file}|${message}`).slice(0, 12), rule, severity, file, line, message };
}

/** PyPI treats case and runs of `-`, `_` and `.` as the same name, so plans and manifests can differ. */
const depKey = (dep: Pick<Dependency, "ecosystem" | "name">): string =>
  `${dep.ecosystem}:${dep.ecosystem === "pypi" ? dep.name.toLowerCase().replace(/[-_.]+/g, "-") : dep.name}`;

function withoutDependencies(text: string): string {
  const parsed = parseJsonc<Record<string, unknown>>(text) ?? {};
  const rest = Object.entries(parsed).filter(([key]) => !/^(dev|peer|optional)?[Dd]ependencies$/.test(key));
  return JSON.stringify(Object.fromEntries(rest.sort(([a], [b]) => (a < b ? -1 : 1))));
}

/** Options that point a package somewhere else, such as a git or path source, or swap it for another crate. */
const REMOTE_OPTION =
  /(^|[\s{,(:"'])(git|path|github|gitlab|bitbucket|branch|rev|tag|registry|registry-index|source|index|url|file|package)["']?\s*(=>|[:=])/;
const remoteSource = (dep: Dependency): boolean =>
  REMOTE_SPECIFIER.test(dep.version) || REMOTE_OPTION.test(dep.source ?? "");

/** How a manifest's blocks are nested: XML elements, brackets, or Ruby do/end. */
type FrameStyle = "brackets" | "ruby" | "xml";
const QUOTED = /"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g;

/** The blocks open before each line, so a line added inside an existing block is judged in context. */
function framesAt(lines: string[], style: FrameStyle): string[][] {
  const stack: string[] = [];
  return lines.map((raw) => {
    const line = raw.trim();
    const frames = [...stack];
    if (style === "xml") {
      for (const tag of line.matchAll(/<(\/?)([A-Za-z][\w:.-]*)[^>]*?(\/?)>/g)) {
        if (tag[1]) {
          const at = stack.lastIndexOf(tag[2]!);
          if (at !== -1) stack.length = at;
        } else if (!tag[3]) {
          stack.push(tag[2]!);
        }
      }
    } else if (style === "ruby") {
      if (/^end\b/.test(line)) stack.pop();
      else if (
        /\bdo\s*(\|[^|]*\|)?$/.test(line) ||
        /^(if|unless|case|begin|def|class|module|while|until)\b/.test(line)
      ) {
        stack.push(line);
      }
    } else {
      for (const char of line.replace(QUOTED, '""').replace(/\/\/.*$/, "")) {
        if ("{[(".includes(char)) stack.push(line);
        else if ("}])".includes(char)) stack.pop();
      }
    }
    return frames;
  });
}

const within = (frames: string[], pattern: RegExp): boolean => frames.some((frame) => pattern.test(frame));
const GEMFILE_BLOCK = /^(source|git_source|plugin|eval_gemfile|git|github|gitlab|bitbucket|path)\b/;
const GEM_SOURCE_KEY =
  /\b(git|github|gitlab|bitbucket|path|source):|[:'"](git|github|gitlab|bitbucket|path|source)['"]?\s*=>/;
const GRADLE_BLOCK = /^(repositories|maven|plugins|exec|buildscript)\b/;

/** What in a planned manifest redirects the build or runs code. Checked on each added line and its blocks. */
const REDIRECTS: [RegExp, FrameStyle, (line: string, frames: string[]) => boolean][] = [
  [/^go\.mod$/, "brackets", (line, frames) => /^replace\b/.test(line) || within(frames, /^replace\s*\(/)],
  [
    /^Gemfile$/,
    "ruby",
    (line, frames) => GEMFILE_BLOCK.test(line) || within(frames, GEMFILE_BLOCK) || GEM_SOURCE_KEY.test(line),
  ],
  [
    /^pom\.xml$/,
    "xml",
    (line, frames) =>
      /<(repositories|pluginRepositories|build|plugin|extensions|parent|relativePath|systemPath)[\s/>]/.test(
        line,
      ) || within(frames, /^(repositories|pluginRepositories|build|plugin|extensions|parent)$/),
  ],
  [
    /^build\.gradle(\.kts)?$/,
    "brackets",
    (line, frames) =>
      /\b(repositories|maven|plugins|exec|buildscript)\s*[({]|\bExec\b|\bapply\s*\(?\s*from\b|\b(files|fileTree|flatDir|project)\s*\(/.test(
        line,
      ) || within(frames, GRADLE_BLOCK),
  ],
  [
    /\.(cs|fs|vb)proj$/,
    "xml",
    (line, frames) =>
      /<(Exec|Target|Import|HintPath|Analyzer|UsingTask|ProjectReference)[\s/>]|\bRestoreSources\b/.test(
        line,
      ) || within(frames, /^Target$/),
  ],
];

type Parsed = Record<string, unknown> | null;
const parseJsonManifest = (text: string): Parsed => parseJsonc<Record<string, unknown>>(text);

/** Keys that redirect the build or run code, compared on the parsed file so no spelling can hide them. */
const SENSITIVE_KEYS: [RegExp, (text: string) => Parsed, string[]][] = [
  [
    /^Cargo\.toml$/,
    parseToml,
    ["patch", "replace", "source", "registries", "registry", "target", "package.build"],
  ],
  [
    /^pyproject\.toml$/,
    parseToml,
    ["build-system", "tool.poetry.source", "tool.uv.sources", "tool.uv.index", "tool.pdm.source"],
  ],
  [/^Pipfile$/, parseToml, ["source"]],
  [/^composer\.json$/, parseJsonManifest, ["repositories", "scripts", "config"]],
];

const lookUp = (doc: Parsed, key: string): unknown =>
  key.split(".").reduce<unknown>((value, part) => (value as Parsed)?.[part], doc ?? undefined);

/** The dependency tables under [target] are audited as dependencies, so only the rest of it is sensitive here. */
function targetSettings(target: unknown): unknown {
  const kept = Object.entries((target ?? {}) as Record<string, Record<string, unknown>>).flatMap(
    ([name, table]) => {
      const rest = Object.entries(table ?? {}).filter(([key]) => !/dependencies$/.test(key));
      return rest.length > 0 ? [[name, Object.fromEntries(rest)]] : [];
    },
  );
  return kept.length > 0 ? Object.fromEntries(kept) : undefined;
}

const valueAt = (doc: Parsed, key: string): unknown =>
  key === "target" ? targetSettings(lookUp(doc, key)) : lookUp(doc, key);

async function auditManifest(
  workspace: Workspace,
  item: FileContent,
  plan: TransplantPlan,
  planned: boolean,
): Promise<AuditFinding[]> {
  const findings: AuditFinding[] = [];
  const allowed = new Map(plan.dependencies.add.map((dep) => [depKey(dep), dep.version]));
  const baseText = await showBaseFile(workspace, item.file);
  // One package can sit in several tables, such as dependencies and dev-dependencies.
  const before = new Map<string, Dependency[]>();
  for (const dep of baseText ? parseManifest(item.file, baseText) : []) {
    before.set(depKey(dep), [...(before.get(depKey(dep)) ?? []), dep]);
  }
  const remoteFinding = (dep: Dependency): AuditFinding =>
    makeFinding(
      "dependency.remote_source",
      "high",
      item.file,
      null,
      `${dep.name} installs from ${dep.source ?? dep.version}.`,
    );
  for (const dep of parseManifest(item.file, item.text)) {
    const key = depKey(dep);
    const seen = before.get(key) ?? [];
    if (seen.some((old) => old.version === dep.version && old.source === dep.source)) continue;
    if (seen.some((old) => old.version === dep.version)) {
      // The same version from a new source: only a remote source is a finding.
      if (remoteSource(dep)) findings.push(remoteFinding(dep));
      continue;
    }
    const previous = seen.at(-1);
    const approved = allowed.get(key);
    if (approved === undefined) {
      const rule = previous === undefined ? "dependency.unapproved" : "dependency.version_changed";
      const change =
        previous === undefined
          ? `${dep.name}@${dep.version}`
          : `${dep.name} ${previous.version} to ${dep.version}`;
      findings.push(makeFinding(rule, "high", item.file, null, `${change} is not in the approved plan.`));
    } else if (approved !== dep.version) {
      findings.push(
        makeFinding(
          "dependency.version_mismatch",
          "high",
          item.file,
          null,
          `${dep.name} is ${dep.version}, but the plan approved ${approved}.`,
        ),
      );
    } else if (remoteSource(dep)) {
      findings.push(remoteFinding(dep));
    }
  }

  const remaining = new Set(parseManifest(item.file, item.text).map(depKey));
  for (const [key, [dep]] of before) {
    const named = (entry: string): boolean =>
      entry === dep!.name || entry.startsWith(`${dep!.name}@`) || entry.startsWith(`${dep!.name} `);
    if (remaining.has(key) || plan.dependencies.dropped.some(named)) continue;
    findings.push(
      makeFinding(
        "dependency.removed",
        "medium",
        item.file,
        null,
        `${dep!.name} was removed, and the plan does not list it under dependencies.dropped.`,
      ),
    );
  }

  const base = path.posix.basename(item.file);
  if (!planned && item.status === "added") {
    findings.push(
      makeFinding("scope.unplanned_file", "high", item.file, null, "New manifest not in the plan."),
    );
  }
  if (base === "package.json") {
    if (!planned && baseText !== null && withoutDependencies(baseText) !== withoutDependencies(item.text)) {
      findings.push(
        makeFinding(
          "manifest.unplanned_change",
          "high",
          item.file,
          null,
          "Fields other than dependencies changed, such as scripts or overrides. List the file in the plan if this is intended.",
        ),
      );
    }
    if (baseText !== null && !plan.sensitive_paths_reason) {
      for (const field of sensitivePackageChanges(baseText, item.text)) {
        findings.push(
          makeFinding(
            "manifest.sensitive_change",
            "high",
            item.file,
            null,
            `${field} changed, which alters what runs. State why in sensitive_paths_reason.`,
          ),
        );
      }
    }
    const beforeScripts = baseText
      ? scanPackageScripts(item.file, baseText).map((entry) => entry.excerpt)
      : [];
    for (const entry of scanPackageScripts(item.file, item.text)) {
      if (!beforeScripts.includes(entry.excerpt)) {
        findings.push(
          makeFinding(
            "supply_chain.install_script",
            "high",
            item.file,
            null,
            `Install script added: ${entry.excerpt}`,
          ),
        );
      }
    }
  }
  const sensitive = SENSITIVE_KEYS.find(([name]) => name.test(base));
  if (sensitive) {
    const [, parse, keys] = sensitive;
    const after = parse(item.text);
    if (after === null) {
      findings.push(
        makeFinding(
          "manifest.unparsed",
          "high",
          item.file,
          null,
          "Does not parse, so it could not be checked.",
        ),
      );
    } else if (!plan.sensitive_paths_reason) {
      const old = baseText === null ? null : parse(baseText);
      for (const key of keys) {
        const value = valueAt(after, key);
        if (value === undefined || canonicalJson(value) === canonicalJson(valueAt(old, key))) continue;
        findings.push(
          makeFinding(
            "manifest.sensitive_change",
            "high",
            item.file,
            null,
            `${key} changed, which alters what the build fetches or runs. State why in sensitive_paths_reason.`,
          ),
        );
      }
    }
  }
  const redirect = REDIRECTS.find(([name]) => name.test(base));
  if (redirect && !plan.sensitive_paths_reason) {
    const [, style, redirects] = redirect;
    const lines = item.text.split("\n");
    const frames = framesAt(lines, style);
    for (const lineNumber of item.addedLines) {
      const line = (lines[lineNumber - 1] ?? "").trim();
      if (!redirects(line, frames[lineNumber - 1] ?? [])) continue;
      findings.push(
        makeFinding(
          "manifest.sensitive_change",
          "high",
          item.file,
          lineNumber,
          `Changes what the build fetches or runs: ${line.slice(0, 120)}. State why in sensitive_paths_reason.`,
        ),
      );
    }
  }
  if (!planned && base !== "package.json" && baseText !== null) {
    const names = parseManifest(item.file, item.text).map((dep) => dep.name.toLowerCase());
    const lines = item.text.split("\n");
    for (const lineNumber of item.addedLines) {
      const line = (lines[lineNumber - 1] ?? "").trim();
      if (!line || /^[#/]/.test(line) || /^[\])}[({,]*$/.test(line)) continue;
      // Only the leading token counts, so a comment that mentions a package excuses nothing.
      const first = line.match(DEPENDENCY_TOKEN)?.[1]?.toLowerCase();
      if (first && names.some((name) => first === name || first.startsWith(`${name}:`))) continue;
      findings.push(
        makeFinding(
          "manifest.unplanned_change",
          "high",
          item.file,
          lineNumber,
          `Not a dependency line: ${line.slice(0, 120)}`,
        ),
      );
    }
  }
  if (isRequirementsFile(item.file)) {
    const lines = item.text.split("\n");
    for (const lineNumber of item.addedLines) {
      const line = (lines[lineNumber - 1] ?? "").trim();
      const option = line.startsWith("-") && !HARMLESS_PIP_OPTION.test(line);
      if (option || REMOTE_SPECIFIER.test(line)) {
        findings.push(
          makeFinding(
            "dependency.remote_source",
            "high",
            item.file,
            lineNumber,
            `Package source changes: ${line}`,
          ),
        );
      }
    }
  }
  return findings;
}

function sensitivePackageChanges(baseText: string, text: string): string[] {
  const before = parseJsonc<Record<string, unknown>>(baseText) ?? {};
  const after = parseJsonc<Record<string, unknown>>(text) ?? {};
  const changes = SENSITIVE_PACKAGE_FIELDS.slice(0, 3).filter(
    (field) => JSON.stringify(before[field]) !== JSON.stringify(after[field]),
  );
  const oldScripts = (before.scripts ?? {}) as Record<string, unknown>;
  const newScripts = (after.scripts ?? {}) as Record<string, unknown>;
  for (const [name, command] of Object.entries(newScripts)) {
    // pretest and friends run around commands the plan approved, without appearing in them.
    const hook = /^(pre|post)/.test(name) || Object.hasOwn(oldScripts, name);
    if (hook && oldScripts[name] !== command) changes.push(`scripts.${name}`);
  }
  return changes;
}

/** Lockfile names run as code when imported, so a lockfile has to look like one. */
function looksLikeLockfile(rel: string, text: string): boolean {
  const base = path.posix.basename(rel);
  if (base.endsWith(".json") || base === "composer.lock" || base === "Pipfile.lock") {
    return parseJsonc(text) !== null;
  }
  if (base === "yarn.lock") return text.split("\n").every((line) => YARN_LOCK_LINE.test(line));
  return !text.split("\n").some((line) => CALL_LIKE.test(line));
}

function verbatimShare(lines: string[], sourceLines: Set<string>): number {
  const meaningful = lines.map((line) => line.trim()).filter((line) => line.length >= 24);
  if (meaningful.length === 0) return 0;
  return meaningful.filter((line) => sourceLines.has(line)).length / meaningful.length;
}

/** Meaningful lines of a file inside the source, read only where containment allows. */
async function sourceLinesOf(sourceRoot: string, rel: string): Promise<Set<string>> {
  const text = await resolveInside(sourceRoot, rel)
    .then((real) => readFile(real, "utf8"))
    .catch(() => "");
  return new Set(
    text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length >= 24),
  );
}

const SPDX_LINE = /SPDX-License-Identifier:\s*([^\r\n*]+)/;
const RESTRICTIVE_LICENSE = new Set<string>([
  "strong_copyleft",
  "network_copyleft",
  "source_available",
  "non_commercial",
]);

/** A license header on an added line must name the source's license or the target's, as license.ts resolves it. */
function licenseHeaders(item: FileContent, license: LicenseReport | undefined): AuditFinding[] {
  if (!license) return [];
  const lines = item.text.split("\n");
  const findings: AuditFinding[] = [];
  for (const lineNumber of item.addedLines) {
    const match = (lines[lineNumber - 1] ?? "").match(SPDX_LINE);
    if (!match) continue;
    const header = resolveExpression(match[1]!.trim());
    const { source, target, file_overrides: overrides } = license;
    const known = [source.spdx, target.spdx, ...overrides.map((item) => item.spdx)].includes(header.spdx);
    if (source.spdx !== null && !known) {
      findings.push(
        makeFinding(
          "license.header_conflict",
          "high",
          item.file,
          lineNumber,
          `SPDX header ${header.spdx} is neither the source's ${source.spdx} nor the target's ${target.spdx ?? "(none)"} license.`,
        ),
      );
    } else if (target.distribution === "proprietary" && RESTRICTIVE_LICENSE.has(header.class)) {
      findings.push(
        makeFinding(
          "license.header_conflict",
          "high",
          item.file,
          lineNumber,
          `SPDX header ${header.spdx} is restrictive, and a proprietary target cannot take it.`,
        ),
      );
    }
  }
  return findings;
}

export interface AuditResult {
  fingerprint: string;
  findings: AuditFinding[];
  metrics: Record<string, unknown>;
  blocking: AuditFinding[];
}

function auditLines(item: FileContent, plan: TransplantPlan, seenEnv: Set<string>): AuditFinding[] {
  const findings: AuditFinding[] = [];
  const allowedEnv = new Set(plan.env_vars.map((entry) => entry.name));
  const declaredDestructive = plan.migrations
    .filter((entry) => entry.destructive)
    .map((entry) => entry.path.replace(/\\/g, "/"));
  const lines = item.text.split("\n");
  const isMigration = MIGRATION_FILE.test(item.file);
  const isRollback = ROLLBACK_FILE.test(path.posix.basename(item.file));
  const flagDestructive = (text: string, lineNumber: number): void => {
    if (isRollback || declaredDestructive.includes(item.file)) return;
    findings.push(
      makeFinding(
        "database.destructive_statement",
        "high",
        item.file,
        lineNumber,
        `Destructive statement not declared in the plan: ${text.trim().slice(0, 120)}`,
      ),
    );
  };
  const flagWeakened = (text: string, lineNumber: number): void => {
    findings.push(
      makeFinding(
        "security.weakened_protection",
        "high",
        item.file,
        lineNumber,
        `Weakens a protection: ${text.trim().slice(0, 120)}`,
      ),
    );
  };

  for (const lineNumber of item.addedLines) {
    const full = lines[lineNumber - 1] ?? "";
    if (SKIPPED_TEST.test(full.slice(0, CHECK_WINDOW))) {
      findings.push(
        makeFinding(
          "tests.skipped",
          "medium",
          item.file,
          lineNumber,
          `Adds a test that does not run: ${full.trim().slice(0, 120)}`,
        ),
      );
    }
    // Long lines are read in overlapping windows with their whitespace collapsed, so padding cannot
    // move a statement out of view or pull it apart.
    const flat = full.length > CHECK_WINDOW ? full.replace(/\s+/g, " ") : full;
    const windows: string[] = [];
    for (let start = 0; start === 0 || start < flat.length; start += CHECK_STEP) {
      windows.push(flat.slice(start, start + CHECK_WINDOW));
    }
    if (full.length > CHECK_WINDOW) {
      findings.push(
        makeFinding(
          "obfuscation.long_line",
          "medium",
          item.file,
          lineNumber,
          "Very long line. Read it closely.",
        ),
      );
    }
    for (const text of windows) {
      if (DESTRUCTIVE_SQL.test(text) || (isMigration && MIGRATION_DESTRUCTIVE.test(text))) {
        flagDestructive(text, lineNumber);
      }
      if (AUTH_WEAKENING.test(text)) flagWeakened(text, lineNumber);
      for (const match of text.matchAll(ENV_REFERENCE)) {
        const name = match[1]!;
        if (allowedEnv.has(name) || AMBIENT_ENV.has(name) || seenEnv.has(name)) continue;
        seenEnv.add(name);
        findings.push(
          makeFinding(
            "env.undeclared",
            "medium",
            item.file,
            lineNumber,
            `${name} is read but not declared in the plan.`,
          ),
        );
      }
    }
  }

  // Formatters split a statement across lines, so each run of added lines is read as one text too.
  const added = [...item.addedLines].sort((a, b) => a - b);
  for (let start = 0, end = 0; start < added.length; start = end) {
    for (end = start + 1; added[end] === added[end - 1]! + 1; end++);
    if (end - start < 2) continue;
    const run = lines
      .slice(added[start]! - 1, added[end - 1]!)
      .join("\n")
      .replace(/[ \t]+/g, " ")
      .replace(/\n\s*\n/g, "\n");
    for (let at = 0; at === 0 || at < run.length; at += CHECK_STEP) {
      const text = run.slice(at, at + CHECK_WINDOW);
      for (const match of text.matchAll(DESTRUCTIVE_ACROSS_LINES)) {
        if (match[0].includes("\n")) flagDestructive(match[0], added[start]!);
      }
      for (const match of text.matchAll(WEAKENING_ACROSS_LINES)) {
        if (match[0].includes("\n")) flagWeakened(match[0], added[start]!);
      }
    }
  }
  return findings;
}

/** Compares the worktree against the approved plan and re-scans every added line. */
export async function auditWorkspace(
  workspace: Workspace,
  plan: TransplantPlan,
  sourceRoot: string,
  acknowledgements: Record<string, string>,
  options: { leftOut?: string[]; license?: LicenseReport } = {},
): Promise<AuditResult> {
  const review = await reviewTree(workspace);
  const findings: AuditFinding[] = [];
  const planned = new Map(plan.files.map((file) => [file.path.replace(/\\/g, "/"), file]));
  const migrationPaths = new Set(plan.migrations.map((item) => item.path.replace(/\\/g, "/")));
  const relevant = review.changed;
  const byPath = new Map(relevant.map((file) => [file.path, file]));
  const isPlanned = (rel: string): boolean => planned.has(rel) || migrationPaths.has(rel);
  const manifests = new Set(
    review.files.filter((file) => isManifest(file.path)).map((file) => path.posix.dirname(file.path)),
  );
  /** A lockfile is expected only next to the manifest it belongs to. Elsewhere it is just a file. */
  const beside = (rel: string): boolean => manifests.has(path.posix.dirname(rel));

  if (review.gitStateChanged) {
    findings.push(
      makeFinding(
        "repository.git_state_changed",
        "high",
        null,
        null,
        "Git config, hooks or attributes changed since the worktree was created. They can alter what a commit stores.",
      ),
    );
  }
  if (review.branchMoved) {
    findings.push(
      makeFinding(
        "repository.branch_moved",
        "high",
        null,
        null,
        "The transplant branch moved from its base. The review covers the working tree, so those commits went unchecked. Reset the branch to its base and keep the changes uncommitted.",
      ),
    );
  }
  if (review.gitLinkChanged) {
    findings.push(
      makeFinding(
        "repository.git_link_changed",
        "high",
        null,
        null,
        "The worktree's .git entry changed. It can point git at settings that run code on the next git command.",
      ),
    );
  }
  if (review.indexChanged) {
    findings.push(
      makeFinding(
        "repository.index_changed",
        "high",
        null,
        null,
        "The worktree's index differs from its commit, so a commit made from it may not match the review. Run `git reset` there, and leave committing to transplant_commit.",
      ),
    );
  }
  for (const name of review.shadowingRefs) {
    findings.push(
      makeFinding(
        "repository.ref_shadowing",
        "high",
        null,
        null,
        `${name} changes what the branch name or a stored object resolves to. Delete it.`,
      ),
    );
  }
  if (review.movedBranches.length > 0) {
    findings.push(
      makeFinding(
        "repository.other_branches_moved",
        "medium",
        null,
        null,
        `Moved during this session: ${review.movedBranches.join(", ")}. Check that you did that.`,
      ),
    );
  }
  const nested = new Set<string>();
  for (const file of relevant) {
    const marker = file.path.match(/^(.*?)(^|\/)\.git(\/|$)/);
    if (marker) {
      if (!nested.has(marker[1]!)) {
        nested.add(marker[1]!);
        findings.push(
          makeFinding(
            "scope.nested_repository",
            "high",
            marker[1] || file.path,
            null,
            "Holds a .git directory or file, which git never commits. Anything in it escapes the commit.",
          ),
        );
      }
      continue;
    }
    if (file.symlink) {
      findings.push(
        makeFinding(
          "scope.symlink",
          "high",
          file.path,
          null,
          "Symbolic link. It is left out of verification, so what it points at goes unchecked.",
        ),
      );
    }
    if (isPlanned(file.path)) continue;
    // A lockfile changes only because packages did, next to the manifest it belongs to.
    if (isLockFile(file.path) && beside(file.path) && plan.dependencies.add.length > 0) {
      const content = review.contents.find((item) => item.file === file.path);
      if (!content || looksLikeLockfile(file.path, content.text)) continue;
    }
    if (isManifest(file.path) && file.status !== "deleted") continue;
    if (/(^|\/)\.env\.(example|sample)$/.test(file.path)) {
      const content = review.contents.find((item) => item.file === file.path);
      if (content?.text.split("\n").every((line) => ENV_TEMPLATE_LINE.test(line))) continue;
    }
    findings.push(
      makeFinding(
        "scope.unplanned_file",
        "high",
        file.path,
        null,
        `Changed but not in the approved plan (${file.status}).`,
      ),
    );
  }
  for (const [rel, file] of planned) {
    const change = byPath.get(rel);
    if (!change) {
      findings.push(
        makeFinding(
          "scope.missing_file",
          "high",
          rel,
          null,
          `Planned to ${file.action} but unchanged. Implement it or update the plan.`,
        ),
      );
    } else if (change.status === "deleted") {
      findings.push(
        makeFinding(
          "scope.deleted_planned_file",
          "high",
          rel,
          null,
          `Planned to ${file.action}, but it was deleted.`,
        ),
      );
    } else if (file.action === "modify" && change.status === "added") {
      findings.push(
        makeFinding(
          "scope.created_instead_of_modified",
          "medium",
          rel,
          null,
          "Plan said modify, but the file is new.",
        ),
      );
    }
  }
  for (const item of plan.migrations) {
    if (!byPath.has(item.path.replace(/\\/g, "/"))) {
      findings.push(
        makeFinding("database.missing_migration", "high", item.path, null, "Planned migration is missing."),
      );
    }
  }
  for (const file of relevant) {
    if (file.status === "deleted") continue;
    if (SENSITIVE_PATH.test(file.path) && !plan.sensitive_paths_reason) {
      findings.push(
        makeFinding(
          "scope.sensitive_path",
          "high",
          file.path,
          null,
          "Touches CI, agent configuration or build tooling without a stated reason.",
        ),
      );
    }
    if (/(^|\/)\.env(\.[^/]*)?$/.test(file.path) && !/\.(example|sample|template)$/.test(file.path)) {
      findings.push(
        makeFinding(
          "secrets.env_file",
          "high",
          file.path,
          null,
          "Real .env files must not be committed. Use .env.example.",
        ),
      );
    }
  }

  const contents = review.contents.filter((item) => !/(^|\/)\.git(\/|$)/.test(item.file));
  const seenEnv = new Set<string>();
  const addedByFile = new Map<string, string[]>();
  let linesAdded = 0;

  for (const item of contents) {
    if (item.tooLarge) {
      findings.push(
        makeFinding("scope.file_too_large", "high", item.file, null, "File is too large to review."),
      );
      continue;
    }
    if (item.loneCr) {
      findings.push(
        makeFinding(
          "obfuscation.lone_cr",
          "high",
          item.file,
          null,
          "Holds a carriage return with no line feed, which shells and editors read differently.",
        ),
      );
    }
    const asset = isAssetExtension(path.posix.extname(item.file).toLowerCase());
    if (item.binary && (!isPlanned(item.file) || (item.undecodable && !asset))) {
      findings.push(
        makeFinding(
          "scope.binary_file",
          "high",
          item.file,
          null,
          "Binary content that the plan does not declare.",
        ),
      );
    }
    if (isLockFile(item.file)) {
      for (const entry of scanLockfile(item.file, item.text)) {
        findings.push(makeFinding(entry.rule, "high", item.file, null, `${entry.message} ${entry.excerpt}`));
      }
    }
    if (isManifest(item.file)) {
      findings.push(...(await auditManifest(workspace, item, plan, isPlanned(item.file))));
    }

    const lines = item.text.split("\n");
    const added = [...item.addedLines].map((lineNumber) => lines[lineNumber - 1] ?? "");
    addedByFile.set(item.file, added);
    linesAdded += added.length;
    findings.push(...auditLines(item, plan, seenEnv));
    findings.push(...licenseHeaders(item, options.license));

    for (const entry of scanText(item.file, item.text, { includeTests: true, everyMatch: true })) {
      if (entry.severity === "info") continue;
      if (entry.line !== null && !item.addedLines.has(entry.line)) continue;
      findings.push(
        makeFinding(
          entry.rule,
          severityOf(entry.severity),
          item.file,
          entry.line,
          `${entry.message} ${entry.excerpt}`,
        ),
      );
    }
  }

  const verbatim: { path: string; share: number }[] = [];
  for (const [rel, file] of planned) {
    // A license notice has to match the source, so a copy there is the point.
    if (file.source_refs.length === 0 || rel === NOTICES_FILE) continue;
    const sourceLines = new Set<string>();
    for (const ref of file.source_refs) {
      for (const line of await sourceLinesOf(sourceRoot, sourcePath(ref))) sourceLines.add(line);
    }
    const lines = addedByFile.get(rel);
    if (!lines || sourceLines.size === 0) continue;
    const share = verbatimShare(lines, sourceLines);
    verbatim.push({ path: rel, share: Math.round(share * 100) / 100 });
    if (share >= 0.7) {
      findings.push(
        makeFinding(
          "adaptation.verbatim_copy",
          "medium",
          rel,
          null,
          `${Math.round(share * 100)}% of meaningful lines match the source verbatim. Keep the license notice, and rewrite to the target's conventions.`,
        ),
      );
    }
  }
  // A file the plan leaves out was never reviewed, so copying from it is a finding of its own.
  // Its lines are counted across all files, so splitting a copy up does not hide it.
  for (const rel of options.leftOut ?? []) {
    const sourceLines = await sourceLinesOf(sourceRoot, rel);
    if (sourceLines.size === 0) continue;
    const copied = new Set<string>();
    const into = new Set<string>();
    for (const [file, lines] of addedByFile) {
      for (const line of lines.map((item) => item.trim())) {
        if (!sourceLines.has(line)) continue;
        copied.add(line);
        into.add(file);
      }
    }
    const mostly = [...addedByFile.values()].some((lines) => verbatimShare(lines, sourceLines) >= 0.7);
    if (!mostly && (copied.size < 2 || copied.size / sourceLines.size < 0.3)) continue;
    findings.push(
      makeFinding(
        "adaptation.copied_from_left_out",
        "high",
        [...into][0]!,
        null,
        `${copied.size} of ${sourceLines.size} meaningful lines of ${rel} appear in ${[...into].join(", ")}. The plan leaves that file out, so nobody reviewed it.`,
      ),
    );
  }

  // An acceptance covers a file as it stood, so a later edit has to be accepted again.
  // A finding on a folder covers everything inside it.
  const covered = (rel: string | null): string =>
    review.files
      .filter((file) => rel !== null && (file.path === rel || file.path.startsWith(`${rel}/`)))
      .map((file) => file.hash)
      .join("");
  const bound = findings.map((item) => ({
    ...item,
    id: sha256(`${item.id}|${covered(item.file)}`).slice(0, 12),
  }));
  const unique = [...new Map(bound.map((item) => [item.id, item])).values()].map((item) =>
    acknowledgements[item.id] && !NOT_ACCEPTABLE.has(item.rule)
      ? { ...item, acknowledged: acknowledgements[item.id] }
      : item,
  );
  return {
    fingerprint: review.fingerprint,
    findings: unique,
    blocking: unique.filter((item) => item.severity === "high" && !item.acknowledged),
    metrics: {
      files_changed: relevant.length,
      lines_added: linesAdded,
      planned_files: planned.size,
      verbatim_overlap: verbatim,
    },
  };
}
