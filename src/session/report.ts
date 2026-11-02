import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import type { TraceResult } from "../analysis/trace.js";
import { TransplantError } from "../util/errors.js";
import { pathExists, readText, writeFileAtomic, writeJsonAtomic } from "../util/fsx.js";
import { sanitizeDisplay } from "../util/text.js";
import { sourcePath } from "./audit.js";
import type { TransplantPlan } from "./schema.js";
import type { Session, VerificationRun } from "./store.js";
import { narrowedChecks, needsBrowserCheck } from "./verify.js";
import { type ChangedFile, NOTICES_FILE } from "./workspace.js";

export interface Provenance {
  schema: 1;
  session_id: string;
  feature: string;
  source: Session["source"];
  license: { spdx: string | null; class: string; verdict: string; conditions: string[]; override?: string };
  transplanted_at: string;
  base_sha: string;
  branch: string;
  file_map: { target: string; source_refs: string[] }[];
  source_files: string[];
  dependencies_added: { name: string; version: string; ecosystem: string }[];
}

function latestByName(runs: VerificationRun[]): VerificationRun[] {
  const latest = new Map<string, VerificationRun>();
  for (const run of runs) latest.set(run.name, run);
  return [...latest.values()];
}

export interface CompletionState {
  fingerprint: string;
  blockers: string[];
  manual_items: string[];
}

export interface LeftOut {
  /** Files the whole-repository scan flagged that the plan does not bring in, with the reasons. */
  files: { path: string; reasons: string[] }[];
  /** Set when the scan's own lists were cut short, so more files may be left out. */
  cut: string | null;
}

const LEFT_OUT_SHOWN = 10;

/** The files a scan or license check should read. Shared files are mapped, not copied, yet the feature needs them. */
export function selectedOf(trace: TraceResult | undefined): string[] {
  if (!trace) return [];
  const shared = trace.shared_infrastructure.map((file) => file.path);
  return [...new Set([...trace.files.map((file) => file.path), ...trace.tests, ...shared])];
}

/** The files each plan cites, without anchors. */
export function planRefs(plan: TransplantPlan): string[] {
  return plan.files.flatMap((file) => file.source_refs.map(sourcePath));
}

/** Flagged files outside the trace, the license and notice files, and the files the plan cites. */
export function leftOutOf(session: Session, refs: string[]): LeftOut {
  const repo = session.repoScan;
  if (!repo) return { files: [], cut: null };
  const subdir = session.source.subdir;
  const fromRoot = (rel: string): string => (subdir ? `${subdir}/${rel}` : rel);
  const legal = [session.license.source.license_file, session.license.source.notice_file].filter(
    (item): item is string => Boolean(item),
  );
  // Legal files are already relative to the repository root, unlike the trace and the refs.
  const inScope = new Set([...[...selectedOf(session.trace), ...refs].map(fromRoot), ...legal]);
  const found = new Map<string, string[]>();
  const add = (rel: string, reason: string): void => {
    found.set(rel, [...(found.get(rel) ?? []), reason]);
  };
  const criticals = repo.security.findings.filter((item) => item.severity === "critical");
  for (const item of criticals) {
    if (!inScope.has(fromRoot(item.path))) add(fromRoot(item.path), `critical ${item.rule}`);
  }
  for (const item of repo.license.file_overrides) {
    if (!inScope.has(item.path)) add(item.path, `license ${item.spdx}`);
  }
  const files = [...found]
    .map(([rel, reasons]) => ({ path: rel, reasons: [...new Set(reasons)] }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const total = repo.security.counts.critical;
  const cut =
    total > criticals.length
      ? `The list was cut: the scan found ${total} critical findings and listed ${criticals.length}, so more files may be left out.`
      : repo.license.file_overrides.length >= 200
        ? "The list was cut: the license check lists at most 200 files, so more files may be left out."
        : null;
  return { files, cut };
}

/** Names the left-out files, capped, with a count of the rest. */
export function leftOutText(left: LeftOut): string {
  const shown = left.files
    .slice(0, LEFT_OUT_SHOWN)
    .map((item) => `${sanitizeDisplay(item.path)} (${item.reasons.join(", ")})`);
  const more = left.files.length - shown.length;
  return [...shown, ...(more > 0 ? [`and ${more} more`] : [])].join("; ");
}

/** Lists everything still standing between this worktree and a report that can say "complete". */
export function completionState(session: Session, fingerprint: string): CompletionState {
  const blockers: string[] = [];
  const manual: string[] = [];
  const plan = session.plan!;
  const spec = session.spec!;

  if (!session.audit) blockers.push("Audit has not run.");
  else if (session.audit.fingerprint !== fingerprint)
    blockers.push("Code changed after the last audit. Run transplant_audit again.");
  else {
    for (const finding of session.audit.findings) {
      if (finding.severity === "high" && !finding.acknowledged) {
        blockers.push(`Audit finding ${finding.id}: ${finding.message}`);
      }
    }
  }

  const runs = latestByName(session.verifications);
  for (const command of plan.verification.commands) {
    const run = runs.find((item) => item.name === command.name);
    if (!run) blockers.push(`Verification ${command.name} has not run.`);
    else if (run.status !== "passed" && run.status !== "known_failures") {
      blockers.push(`Verification ${command.name} ${run.status}.`);
    } else if (run.fingerprint !== fingerprint) {
      blockers.push(`Code changed after verification ${command.name}. Run it again.`);
    } else if (run.status === "known_failures" && run.kind !== "test" && run.kind !== "e2e") {
      // Identical output can mean it stopped before reaching any of this work.
      manual.push(
        `${command.name} fails the same way on the base commit, so it may not have checked this work.`,
      );
    }
  }

  for (const criterion of spec.acceptance_criteria) {
    const evidence = session.evidence.filter((item) => item.acceptance_criterion === criterion.id).at(-1);
    if (!evidence) blockers.push(`${criterion.id} has no evidence.`);
    else if (evidence.status === "fail") blockers.push(`${criterion.id} failed: ${evidence.detail}`);
    else if (evidence.status === "manual_required") manual.push(`${criterion.id}: ${evidence.detail}`);
    else if (evidence.fingerprint !== fingerprint)
      blockers.push(`${criterion.id} evidence is stale because the code changed.`);
  }
  return { fingerprint, blockers, manual_items: manual };
}

const statusLabel = (file: ChangedFile): string => file.status;

/** A fence longer than any run of backticks in the text, so a license file cannot break out of it. */
function fenced(text: string): string[] {
  const longest = Math.max(2, ...(text.match(/`+/g) ?? []).map((run) => run.length));
  const fence = "`".repeat(longest + 1);
  return [`${fence}text`, sanitizeDisplay(text.trim()).replaceAll("\ufffd", " "), fence];
}

function renderReport(
  session: Session,
  files: ChangedFile[],
  state: CompletionState,
  status: string,
): string {
  const { spec, plan, license, approval, workspace, audit, trace } = session;
  const lines: string[] = [];
  const push = (...items: string[]): void => {
    lines.push(...items);
  };
  push(`# Transplant report: ${spec!.name}`, "");
  const accepted =
    audit?.findings.filter((item) => item.acknowledged && item.severity === "high").length ?? 0;
  push(`- **Status:** ${status}${accepted > 0 ? ` (${accepted} high audit findings accepted)` : ""}`);
  push(
    `- **Source:** ${session.source.url} @ \`${session.source.sha}\`${session.source.subdir ? ` (${session.source.subdir})` : ""}`,
  );
  push(`- **Branch:** \`${workspace!.branch}\` from \`${workspace!.baseSha.slice(0, 12)}\``);
  push(`- **Session:** \`${session.id}\``, "");
  push("## Summary", "", spec!.summary, "");
  push("## License", "");
  push(`- Source: ${license.source.spdx ?? "none detected"} (${license.source.class})`);
  push(`- Target: ${license.target.spdx ?? "none detected"}, distribution ${license.target.distribution}`);
  push(`- Verdict: **${license.verdict}**`);
  for (const condition of license.conditions) push(`- Condition: ${condition}`);
  const recordedBy =
    approval?.via === "elicitation" ? "confirmed in the client dialog" : "recorded by the agent";
  if (approval?.licenseOverride) push(`- Override (${recordedBy}): ${approval.licenseOverride}`);
  if (approval?.securityOverride) push(`- Security override (${recordedBy}): ${approval.securityOverride}`);
  if (approval) push(`- Plan approval: ${recordedBy}`);
  const replaced = (session.approvedPlans?.length ?? 1) - 1;
  if (replaced > 0) push(`- The plan was replaced ${replaced} time(s) after approval, with new approval.`);
  push(`- ${license.disclaimer}`, "");

  const left = leftOutOf(session, planRefs(plan!));
  if (left.files.length > 0 || left.cut) {
    const repo = session.repoScan?.security;
    push("## Repository scan", "");
    push(
      `- Whole repository: ${repo?.risk ?? "unknown"} (${repo?.counts.critical ?? 0} critical, ${repo?.counts.high ?? 0} high). Selected files: ${session.security.risk}.`,
    );
    push(`- Left out of this transplant: ${leftOutText(left) || "nothing named"}`);
    push(`- Reason: ${plan!.out_of_scope_reason ?? "none given"}`);
    if (left.cut) push(`- ${left.cut}`);
    push("");
  }

  push("## Changed files", "", "| File | Change | Purpose |", "| --- | --- | --- |");
  const purposes = new Map(plan!.files.map((file) => [file.path, file.purpose]));
  for (const file of files)
    push(
      `| \`${file.path}\` | ${statusLabel(file)} | ${(purposes.get(file.path) ?? "").replace(/\|/g, "\\|")} |`,
    );
  push("");

  push("## Dependencies", "");
  if (plan!.dependencies.add.length === 0) push("- None added.");
  for (const dep of plan!.dependencies.add) push(`- Added ${dep.name}@${dep.version}: ${dep.reason}`);
  for (const item of plan!.dependencies.reuse) push(`- Reused: ${item}`);
  for (const item of plan!.dependencies.dropped) push(`- Dropped: ${item}`);
  push("");

  if (plan!.migrations.length > 0 || plan!.env_vars.length > 0 || spec!.backend) {
    push("## Backend changes", "");
    for (const route of spec!.backend?.api ?? [])
      push(`- \`${route.method} ${route.path}\`, auth: ${route.auth}`);
    for (const migration of plan!.migrations) {
      push(
        `- Migration \`${migration.path}\`: ${migration.reversible ? "reversible" : "NOT reversible"}. Rollback: ${migration.rollback}`,
      );
    }
    for (const env of plan!.env_vars)
      push(
        `- Env \`${env.name}\`${env.secret ? " (secret)" : ""}${env.required ? " (required)" : ""}: ${env.purpose}`,
      );
    push("");
  }

  push("## Verification", "", "| Command | Result | Isolation | Time |", "| --- | --- | --- | --- |");
  for (const run of latestByName(session.verifications)) {
    push(
      `| \`${run.command.replace(/\|/g, "\\|")}\` | ${run.status} | ${run.isolation} | ${(run.duration_ms / 1000).toFixed(1)}s |`,
    );
  }
  const known = latestByName(session.verifications).filter((run) => run.status === "known_failures");
  if (known.length > 0) {
    push("", "Failures that also happen on the base commit, so this work did not cause them:", "");
    for (const run of known) {
      const names = run.failures ?? [];
      if (names.length === 0)
        push(`- \`${run.name}\` fails the same way, so it proves nothing about this work.`);
      for (const name of names) push(`- \`${run.name}\`: ${name}`);
    }
  }
  const narrowed = narrowedChecks(plan!);
  if (narrowed.length > 0) {
    push("", "**These checks ran only part of the test suite:**", "");
    for (const command of narrowed) push(`- \`${command}\``);
  }
  if (needsBrowserCheck(plan!)) {
    const reason = plan!.verification.no_browser_check_reason;
    push("", `**No check opened this feature in a real browser.** ${reason} Try it before you merge.`);
  }
  push(
    "",
    "## Acceptance criteria",
    "",
    "| ID | Checked by | Criterion | Result | Evidence |",
    "| --- | --- | --- | --- | --- |",
  );
  for (const criterion of spec!.acceptance_criteria) {
    const evidence = session.evidence.filter((item) => item.acceptance_criterion === criterion.id).at(-1);
    const cell = (value: string): string => value.replace(/\|/g, "\\|").replace(/\n/g, " ");
    push(
      `| ${criterion.id} | ${cell(`${criterion.verification}, ${evidence?.kind ?? "none"}`)} | ${cell(`${criterion.when} → ${criterion.then}`)} | ${evidence?.status ?? "missing"} | ${cell(evidence?.detail ?? "")} |`,
    );
  }
  push("");

  const acknowledged = audit?.findings.filter((item) => item.acknowledged) ?? [];
  const open = audit?.findings.filter((item) => !item.acknowledged) ?? [];
  push("## Audit", "");
  if (open.length === 0 && acknowledged.length === 0) push("- No findings.");
  for (const item of open) push(`- [${item.severity}] ${item.rule} ${item.file ?? ""}: ${item.message}`);
  for (const item of acknowledged)
    push(`- [accepted] ${item.rule} ${item.file ?? ""}: ${item.message} Reason: ${item.acknowledged}`);
  push("");

  push("## Needs a person", "");
  const manual = [
    ...state.manual_items,
    ...plan!.env_vars.filter((env) => env.required).map((env) => `Set ${env.name} in each environment.`),
  ];
  if (trace?.shared_infrastructure.length)
    manual.push("Check the shared modules that were mapped to target equivalents.");
  if (plan!.migrations.length > 0)
    manual.push("Run the migrations yourself. This tool never runs them against a shared database.");
  if (status !== "complete") for (const blocker of state.blockers) manual.push(`Blocked: ${blocker}`);
  if (manual.length === 0) push("- Nothing.");
  for (const item of manual) push(`- ${item}`);
  push("", "## Rollback", "", plan!.rollback, "");
  return lines.join("\n");
}

async function writeNotices(
  session: Session,
  sourceRoot: string,
  worktree: string,
  maxBytes: number,
): Promise<boolean> {
  const { license } = session;
  if (license.source.class === "public_domain" || license.source.class === "none") return false;
  const marker = `<!-- transplant:${session.source.url} -->`;
  const file = path.join(worktree, NOTICES_FILE);
  const current = (await pathExists(file)) ? await readFile(file, "utf8") : "# Third-party notices\n";
  if (current.includes(marker)) return false;
  const licenseText = license.source.license_file
    ? await readText(path.join(sourceRoot, license.source.license_file), maxBytes)
    : null;
  const noticeText = license.source.notice_file
    ? await readText(path.join(sourceRoot, license.source.notice_file), maxBytes)
    : null;
  const section = [
    "",
    marker,
    `## ${session.spec!.name}`,
    "",
    `Adapted from ${session.source.url} at commit ${session.source.sha} under ${license.source.spdx ?? "its license"}.`,
    ...license.source.copyright.map((line) => `\n${sanitizeDisplay(line).replace(/[`<>]/g, " ")}`),
    "",
    ...(licenseText ? fenced(licenseText) : []),
    ...(noticeText ? ["", "NOTICE:", "", ...fenced(noticeText)] : []),
    "",
  ];
  await writeFileAtomic(file, `${current.trimEnd()}\n${section.join("\n")}`);
  return true;
}

export interface ReportResult {
  status: "complete" | "incomplete";
  report_path: string;
  provenance_path: string;
  notices_updated: boolean;
  markdown: string;
}

/** Refuses a path that a link or junction in the worktree would carry somewhere else. */
async function assertPlainPath(root: string, rel: string): Promise<void> {
  let current = root;
  for (const part of rel.split("/")) {
    current = path.join(current, part);
    const info = await lstat(current).catch(() => null);
    if (!info) return;
    if (info.isSymbolicLink()) {
      throw new TransplantError("unsafe_path", `${rel} runs through a link, so nothing was written.`);
    }
  }
}

export async function writeReport(
  session: Session,
  sourceRoot: string,
  state: CompletionState,
  maxBytes: number,
  files: ChangedFile[],
): Promise<ReportResult> {
  const workspace = session.workspace!;
  const status = state.blockers.length === 0 ? "complete" : "incomplete";
  const markdown = renderReport(session, files, state, status);
  const directory = path.join(workspace.path, ".transplant");
  const reportPath = path.join(directory, "reports", `${session.id}.md`);
  const provenancePath = path.join(directory, "provenance", `${session.id}.json`);
  for (const rel of [`.transplant/reports/${session.id}.md`, `.transplant/provenance/${session.id}.json`]) {
    await assertPlainPath(workspace.path, rel);
  }
  await assertPlainPath(workspace.path, NOTICES_FILE);
  await writeFileAtomic(reportPath, markdown);

  const sourceFiles = new Set(session.trace?.files.map((file) => file.path) ?? []);
  for (const file of session.plan!.files) {
    for (const ref of file.source_refs) sourceFiles.add(sourcePath(ref));
  }
  const provenance: Provenance = {
    schema: 1,
    session_id: session.id,
    feature: session.feature,
    source: session.source,
    license: {
      spdx: session.license.source.spdx,
      class: session.license.source.class,
      verdict: session.license.verdict,
      conditions: session.license.conditions,
      override: session.approval?.licenseOverride,
    },
    transplanted_at: new Date().toISOString(),
    base_sha: workspace.baseSha,
    branch: workspace.branch,
    file_map: session.plan!.files.map((file) => ({ target: file.path, source_refs: file.source_refs })),
    source_files: [...sourceFiles].sort(),
    dependencies_added: session.plan!.dependencies.add.map(({ name, version, ecosystem }) => ({
      name,
      version,
      ecosystem,
    })),
  };
  await writeJsonAtomic(provenancePath, provenance);
  // Notices belong to work that is done. An incomplete report would leave them as an unplanned change.
  const noticesUpdated =
    status === "complete" && (await writeNotices(session, sourceRoot, workspace.path, maxBytes));
  return {
    status,
    report_path: reportPath,
    provenance_path: provenancePath,
    notices_updated: noticesUpdated,
    markdown,
  };
}
