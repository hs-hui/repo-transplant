import { readFile } from "node:fs/promises";
import path from "node:path";
import { type Dependency, isManifest, parseManifest } from "../analysis/manifests.js";
import { scanLockfile, scanPackageScripts, scanText } from "../analysis/security.js";
import { isLockFile } from "../repo/walk.js";
import { parseJsonc, sha256 } from "../util/fsx.js";
import type { TransplantPlan } from "./schema.js";
import type { AuditFinding } from "./store.js";
import { type FileContent, NOTICES_FILE, reviewTree, showBaseFile, type Workspace } from "./workspace.js";

/** Paths that change what runs on a developer's machine or in CI rather than what the product does. */
export const SENSITIVE_PATH =
  /(^|\/)(\.github\/workflows\/|\.gitlab-ci\.yml|\.circleci\/|CLAUDE\.md|AGENTS\.md|GEMINI\.md|\.cursorrules|\.clinerules|\.mcp\.json|\.claude\/|\.cursor\/|\.husky\/|\.npmrc|\.yarnrc|\.pypirc|\.gitattributes|Dockerfile)/;

const DESTRUCTIVE_SQL =
  /\b(DROP\s+(TABLE|COLUMN|SCHEMA|DATABASE|INDEX)|TRUNCATE\s+(TABLE\s+)?\w|ALTER\s+TABLE\s+\S+\s+DROP|DELETE\s+FROM\s+\w+)/i;
const MIGRATION_DESTRUCTIVE =
  /\b(op\.drop_(table|column)|remove_column|drop_table|dropTable|dropColumn|DropTable|DropColumn|migrations\.(DeleteModel|RemoveField))\b/;
const MIGRATION_FILE =
  /(^|\/)(migrations?|alembic\/versions|db\/migrate|database\/migrations|prisma\/migrations|drizzle)\/|\.sql$/;
const ROLLBACK_FILE = /(^|[._-])(down|rollback|revert)([._-]|$)/i;
const AUTH_WEAKENING =
  /\b(verify\s*[:=]\s*(false|False)|rejectUnauthorized\s*:\s*false|csrf_exempt|@AllowAnonymous|\[AllowAnonymous\]|skip_before_action\s+:(authenticate|verify_authenticity)|cors\(\s*\{\s*origin\s*:\s*(true|['"`]\*['"`])|Access-Control-Allow-Origin['"`]?\s*[:,]\s*['"`]\*)/;
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
/** Requirements lines that change where packages come from rather than which ones are installed. */
const INDEX_REDIRECT =
  /^\s*(-e|--editable|-i|--index-url|--extra-index-url|--find-links|-f|--trusted-host)\b/;
const REMOTE_SPECIFIER = /^(https?:|git\+|git:|github:|file:|link:|ssh:)|@\s*(https?|git\+)/;
const CHECK_WINDOW = 4000;
const DEPENDENCY_TOKEN =
  /^(?:gem\s+|implementation\s*\(?\s*|api\s*\(?\s*|compileOnly\s*\(?\s*|runtimeOnly\s*\(?\s*|testImplementation\s*\(?\s*|require\s+)?['"]?([@\w./:-]+)['"]?(?:\[[^\]]*\])?\s*(?:[=<>~!^,:]|\sv?\d|$)/;
const ENV_TEMPLATE_LINE = /^\s*(#.*|(export\s+)?[A-Z][A-Z0-9_]*=[^()`;{}]*)?$/;
const YARN_LOCK_LINE = /^(#.*|"?[@\w][^()`;]*:|\s+"?[@\w./-]+"?(:| "?[^()`;]*"?)\s*|\s+[@\w"][^()`;]*:|)$/;
const CALL_LIKE = /(^|[\s;(=])[A-Za-z_$][\w$.]*\(/;
const CHECK_STEP = 3600;
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

const depKey = (dep: Pick<Dependency, "ecosystem" | "name">): string => `${dep.ecosystem}:${dep.name}`;

function withoutDependencies(text: string): string {
  const parsed = parseJsonc<Record<string, unknown>>(text) ?? {};
  const rest = Object.entries(parsed).filter(([key]) => !/^(dev|peer|optional)?[Dd]ependencies$/.test(key));
  return JSON.stringify(Object.fromEntries(rest.sort(([a], [b]) => (a < b ? -1 : 1))));
}

async function auditManifest(
  workspace: Workspace,
  item: FileContent,
  plan: TransplantPlan,
  planned: boolean,
): Promise<AuditFinding[]> {
  const findings: AuditFinding[] = [];
  const allowed = new Map(plan.dependencies.add.map((dep) => [depKey(dep), dep.version]));
  const baseText = await showBaseFile(workspace, item.file);
  const before = new Map(
    (baseText ? parseManifest(item.file, baseText) : []).map((dep) => [depKey(dep), dep.version]),
  );
  for (const dep of parseManifest(item.file, item.text)) {
    const key = depKey(dep);
    const previous = before.get(key);
    if (previous === dep.version) continue;
    const approved = allowed.get(key);
    if (approved === undefined) {
      const rule = previous === undefined ? "dependency.unapproved" : "dependency.version_changed";
      const change =
        previous === undefined ? `${dep.name}@${dep.version}` : `${dep.name} ${previous} to ${dep.version}`;
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
    } else if (REMOTE_SPECIFIER.test(dep.version)) {
      findings.push(
        makeFinding(
          "dependency.remote_source",
          "high",
          item.file,
          null,
          `${dep.name} installs from ${dep.version}.`,
        ),
      );
    }
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
  if (/^requirements/.test(base)) {
    const lines = item.text.split("\n");
    for (const lineNumber of item.addedLines) {
      const line = lines[lineNumber - 1] ?? "";
      if (INDEX_REDIRECT.test(line) || REMOTE_SPECIFIER.test(line.trim())) {
        findings.push(
          makeFinding(
            "dependency.remote_source",
            "high",
            item.file,
            lineNumber,
            `Package source changes: ${line.trim()}`,
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

  for (const lineNumber of item.addedLines) {
    const full = lines[lineNumber - 1] ?? "";
    // Long lines are read in overlapping windows, so padding cannot move a statement out of view.
    const windows: string[] = [];
    for (let start = 0; start === 0 || start < full.length; start += CHECK_STEP) {
      windows.push(full.slice(start, start + CHECK_WINDOW));
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
      const destructive = DESTRUCTIVE_SQL.test(text) || (isMigration && MIGRATION_DESTRUCTIVE.test(text));
      if (destructive && !isRollback && !declaredDestructive.includes(item.file)) {
        findings.push(
          makeFinding(
            "database.destructive_statement",
            "high",
            item.file,
            lineNumber,
            `Destructive statement not declared in the plan: ${text.trim().slice(0, 120)}`,
          ),
        );
      }
      if (AUTH_WEAKENING.test(text)) {
        findings.push(
          makeFinding(
            "security.weakened_protection",
            "high",
            item.file,
            lineNumber,
            `Weakens a protection: ${text.trim().slice(0, 120)}`,
          ),
        );
      }
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
  return findings;
}

/** Compares the worktree against the approved plan and re-scans every added line. */
export async function auditWorkspace(
  workspace: Workspace,
  plan: TransplantPlan,
  sourceRoot: string,
  acknowledgements: Record<string, string>,
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
    if (item.binary && !isPlanned(item.file)) {
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
      const clean = ref.split("#")[0]!.split(":")[0]!;
      const text = await readFile(path.join(sourceRoot, clean), "utf8").catch(() => "");
      for (const line of text.split(/\r?\n/)) if (line.trim().length >= 24) sourceLines.add(line.trim());
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
