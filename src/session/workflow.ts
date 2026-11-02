import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { buildGraph } from "../analysis/graph.js";
import { checkLicense, type Distribution, type LicenseReport } from "../analysis/license.js";
import { type SecurityReport, scanRepository } from "../analysis/security.js";
import { traceFeature } from "../analysis/trace.js";
import type { Config } from "../config.js";
import { loadSnapshot, type Snapshot } from "../repo/fetch.js";
import { walkRepo } from "../repo/walk.js";
import { TransplantError } from "../util/errors.js";
import { canonicalJson, pathExists, readText, sha256 } from "../util/fsx.js";
import { auditWorkspace, SENSITIVE_PATH, sourcePath } from "./audit.js";
import {
  type CompletionState,
  completionState,
  leftOutOf,
  leftOutText,
  planRefs,
  selectedOf,
  writeReport,
} from "./report.js";
import { type EvidenceInput, FeatureSpec, TransplantPlan } from "./schema.js";
import {
  deleteRunFiles,
  deleteSessionFiles,
  loadSession,
  newSessionId,
  runRoot,
  type Session,
  type Stage,
  saveSession,
  sessionDir,
} from "./store.js";
import {
  assertLocalEnv,
  hidesGoSkips,
  narrowedChecks,
  needsBrowserCheck,
  runBaseline,
  runsInstallScripts,
  runVerification,
  stripAnsi,
} from "./verify.js";
import {
  assertGitRepo,
  branchTip,
  buildReviewedCommit,
  createWorkspace,
  isMerged,
  landCommit,
  readTargetState,
  recordTargetSettings,
  recordToolFiles,
  removeWorkspace,
  resolveCommit,
  reviewTree,
  toolPaths,
  type Workspace,
  workspaceFingerprint,
} from "./workspace.js";

const MIN_EVIDENCE_TEXT = 6;
/** Words every test reporter prints, which prove nothing about a particular test. */
const REPORTER_WORD =
  /^(duration(_ms)?|tests?|test files?|test suites?|suites?|snapshots?|start at|pass(ed|es|ing)?|fail(ed|s|ing|ures?)?|skipped|todo|cancelled|summary|running)$/i;
/** How test reporters mark a test that did not run. */
const SKIPPED_TEST_LINE =
  /#\s*(?:SKIP|TODO)\b|--- SKIP\b|\bSKIPPED\b|\bPENDING\b|\.\.\. skipped\b|^\s*(?:[↓○□﹣✎]|- )/;
const ORDER: Stage[] = ["started", "traced", "specified", "planned", "approved", "implementing", "reported"];

function requireStage(session: Session, minimum: Stage, action: string): void {
  if (session.stage === "discarded") {
    throw new TransplantError("session_discarded", "This session was discarded.");
  }
  if (ORDER.indexOf(session.stage) < ORDER.indexOf(minimum)) {
    throw new TransplantError(
      "wrong_stage",
      `${action} needs stage ${minimum}, but the session is at ${session.stage}.`,
      nextStep(session),
    );
  }
}

export function nextStep(session: Session): string {
  switch (session.stage) {
    case "started":
      return "Call transplant_trace with seed files from feature_search.";
    case "traced":
      return "Read the traced files, then call transplant_record_spec.";
    case "specified":
      return "Call transplant_record_plan.";
    case "planned":
      return "Show the plan to the user, then call transplant_approve with their answer.";
    case "approved":
      return "Call transplant_create_workspace.";
    case "implementing":
      return "Edit only inside the workspace, then run transplant_audit, transplant_verify and transplant_record_evidence, then transplant_report.";
    case "reported":
      return "Show the report. When the user asks to commit, call transplant_commit, and give them the commit to merge.";
    default:
      return "This session is closed.";
  }
}

export interface StartInput {
  snapshot_id: string;
  target_path: string;
  feature: string;
  distribution?: Distribution;
  base_ref?: string;
}

/** Checks the whole source, before a trace narrows the view. */
async function scanWhole(
  config: Config,
  snapshot: Snapshot,
  target: string,
  distribution: Distribution | undefined,
): Promise<{ security: SecurityReport; license: LicenseReport }> {
  const license = await checkLicense(snapshot.root, target, {
    subdir: snapshot.subdir,
    distribution,
    maxFileBytes: config.maxFileBytes,
  });
  const security = await scanRepository(snapshot.analysisRoot, {
    maxFileBytes: config.maxFileBytes,
    limit: 60,
  });
  return { security, license };
}

export async function startSession(config: Config, input: StartInput): Promise<Session> {
  const snapshot = await loadSnapshot(input.snapshot_id, config);
  const requested = path.resolve(input.target_path);
  if (!(await pathExists(requested))) {
    throw new TransplantError("target_not_found", `Target not found: ${requested}`);
  }
  const target = await assertGitRepo(requested);
  const state = await readTargetState(target);
  const { license, security } = await scanWhole(config, snapshot, target, input.distribution);
  const now = new Date().toISOString();
  const session: Session = {
    id: newSessionId(input.feature),
    createdAt: now,
    updatedAt: now,
    stage: "started",
    feature: input.feature,
    source: {
      snapshotId: snapshot.id,
      url: snapshot.url,
      sha: snapshot.sha,
      ref: snapshot.ref,
      subdir: snapshot.subdir,
    },
    target: {
      path: target,
      headSha: state.headSha,
      dirty: state.dirty,
      baseRef: input.base_ref ?? "HEAD",
      settings: await recordTargetSettings(target),
    },
    license,
    security,
    repoScan: { security, license },
    acknowledgements: {},
    verifications: [],
    evidence: [],
  };
  await saveSession(config, session);
  return session;
}

/** The part of the snapshot the analysis covers, as a path from its root, or null when the file lies outside. */
function analysisPath(rel: string, subdir: string | undefined): string | null {
  if (!subdir) return rel;
  return rel.startsWith(`${subdir}/`) ? rel.slice(subdir.length + 1) : null;
}

/** Scans the selected files, the license and notice files, and any files a plan cites. Tracing and planning share it. */
async function scanSelection(
  config: Config,
  snapshot: Snapshot,
  session: Session,
  selected: string[],
): Promise<{ security: SecurityReport; license: LicenseReport }> {
  // License and notice text is copied into the target, so it gets scanned as well.
  const legalFiles = [session.license.source.license_file, session.license.source.notice_file].filter(
    (item): item is string => Boolean(item),
  );
  const fromRoot = (rel: string): string => (snapshot.subdir ? `${snapshot.subdir}/${rel}` : rel);
  const security = await scanRepository(snapshot.root, {
    paths: [...selected.map(fromRoot), ...legalFiles],
    maxFileBytes: config.maxFileBytes,
  });
  const license = await checkLicense(snapshot.root, session.target.path, {
    subdir: snapshot.subdir,
    distribution: session.license.target.distribution,
    maxFileBytes: config.maxFileBytes,
    paths: selected.map(fromRoot),
  });
  return { security, license };
}

export async function traceSession(
  config: Config,
  id: string,
  options: { seeds: string[]; exclude?: string[]; maxDepth?: number; maxFiles?: number },
): Promise<Session> {
  const session = await loadSession(config, id);
  requireStage(session, "started", "Tracing");
  // A narrower trace could drop a license problem while the code it found stays in the worktree.
  if (ORDER.indexOf(session.stage) >= ORDER.indexOf("approved") || session.workspace) {
    throw new TransplantError(
      "already_approved",
      "The plan is approved. Start a new session to change the feature's scope.",
    );
  }
  const snapshot = await loadSnapshot(session.source.snapshotId, config);
  const graph = await buildGraph(snapshot.analysisRoot, config.maxFileBytes);
  const trace = traceFeature(graph, options);
  session.trace = trace;
  const scan = await scanSelection(config, snapshot, session, selectedOf(trace));
  session.security = scan.security;
  session.license = scan.license;
  session.stage = "traced";
  session.spec = undefined;
  session.plan = undefined;
  session.planHash = undefined;
  session.approval = undefined;
  await saveSession(config, session);
  return session;
}

export async function recordSpec(config: Config, id: string, rawSpec: unknown): Promise<Session> {
  const session = await loadSession(config, id);
  requireStage(session, "traced", "Recording the spec");
  if (session.stage === "reported") {
    throw new TransplantError("already_reported", "The report is written. Start a new session to change it.");
  }
  const spec = FeatureSpec.parse(rawSpec);
  const ids = spec.acceptance_criteria.map((item) => item.id);
  if (new Set(ids).size !== ids.length)
    throw new TransplantError("invalid_spec", "Acceptance criterion ids must be unique.");

  const backend = session.trace!.backend;
  const serverSurface =
    backend.routes.length + backend.data.length + backend.migrations.length + backend.jobs.length;
  if (serverSurface > 0 && !spec.backend && !spec.backend_excluded_reason) {
    throw new TransplantError(
      "backend_unaddressed",
      `The traced feature has server code (${backend.routes.length} routes, ${backend.data.length} models, ${backend.migrations.length} migrations, ${backend.jobs.length} jobs).`,
      "Add a backend section, or set backend_excluded_reason to say why it stays out.",
    );
  }
  if (spec.backend) {
    const secretNames = backend.env_vars.filter((item) => item.likely_secret).map((item) => item.name);
    const covered = new Set(spec.backend.env.map((item) => item.name));
    const missing = secretNames.filter((name) => !covered.has(name));
    const mentioned = JSON.stringify(spec).toUpperCase();
    const unaddressed = missing.filter((name) => !mentioned.includes(name));
    if (unaddressed.length > 0) {
      throw new TransplantError(
        "secrets_unaddressed",
        `The traced code reads secrets the spec does not mention: ${unaddressed.join(", ")}.`,
        "List them in backend.env, or name them in out_of_scope.",
      );
    }
  }
  session.spec = spec;
  session.plan = undefined;
  session.planHash = undefined;
  session.approval = undefined;
  session.stage = "specified";
  await saveSession(config, session);
  return session;
}

/**
 * Rewrites the files a plan cites to the snapshot's own spelling, so the scan, the audit and the report
 * all mean the same file. A ref that names nothing the scan lists is refused, since it would go unread.
 */
async function canonicalRefs(
  root: string,
  subdir: string | undefined,
  plan: TransplantPlan,
  problems: string[],
): Promise<void> {
  const listed = (await walkRepo(root, { full: true })).map((file) => file.rel);
  const exact = new Set(listed);
  const folded = new Map(listed.map((rel) => [rel.toLowerCase(), rel]));
  for (const file of plan.files) {
    file.source_refs = file.source_refs.flatMap((ref) => {
      const named = sourcePath(ref);
      const normal = path.posix.normalize(named);
      const rel = subdir && normal.startsWith(`${subdir}/`) ? normal.slice(subdir.length + 1) : normal;
      const known = exact.has(rel) ? rel : folded.get(rel.toLowerCase());
      if (known) return [`${known}${ref.replace(/\\/g, "/").slice(named.length)}`];
      problems.push(`Source ref ${ref} is not a file the scan can read. Cite a file inside the source.`);
      return [];
    });
  }
}

function validatePlan(plan: TransplantPlan, spec: FeatureSpec): string[] {
  const problems: string[] = [];
  const paths = plan.files.map((file) => file.path.replace(/\\/g, "/"));
  for (const rel of paths) {
    if (rel.startsWith("/") || /^[a-zA-Z]:/.test(rel) || rel.split("/").includes(".."))
      problems.push(`Unsafe path: ${rel}`);
    if (rel.startsWith(".transplant/")) problems.push(`${rel} is reserved for tool output.`);
  }
  if (needsBrowserCheck(plan) && !plan.verification.no_browser_check_reason) {
    problems.push(
      "This plan changes UI files and has no e2e command. Add a real browser check, as the frontend guide shows, or set verification.no_browser_check_reason.",
    );
  }
  if (plan.verification.services.length > 0 && !plan.verification.docker_image) {
    problems.push("Services need verification.docker_image.");
  }
  const covered = new Set(plan.files.flatMap((file) => file.acceptance_criteria));
  const known = new Set(spec.acceptance_criteria.map((item) => item.id));
  for (const id of known) if (!covered.has(id)) problems.push(`${id} is not assigned to any planned file.`);
  for (const id of covered) if (!known.has(id)) problems.push(`Unknown acceptance criterion ${id}.`);

  for (const migration of plan.migrations) {
    if (!migration.reversible && !migration.destructive_reason) {
      problems.push(`Migration ${migration.path} is not reversible. Give a reason or make it reversible.`);
    }
    if (migration.destructive && !migration.destructive_reason) {
      problems.push(`Migration ${migration.path} is destructive and needs destructive_reason.`);
    }
  }
  if (
    (spec.backend?.data_model ?? []).some((item) => item.change !== "reuse") &&
    plan.migrations.length === 0
  ) {
    problems.push("The spec changes the data model, so the plan needs a migration.");
  }
  const planEnv = new Set(plan.env_vars.map((item) => item.name));
  for (const env of spec.backend?.env ?? []) {
    if (!planEnv.has(env.name)) problems.push(`Env var ${env.name} is in the spec but not the plan.`);
  }
  const sensitive = paths.filter((rel) => SENSITIVE_PATH.test(rel));
  if (sensitive.length > 0 && !plan.sensitive_paths_reason) {
    problems.push(`Sensitive paths need sensitive_paths_reason: ${sensitive.join(", ")}`);
  }
  const names = plan.verification.commands.map((item) => item.name);
  if (new Set(names).size !== names.length) problems.push("Verification command names must be unique.");
  const needsTests = spec.acceptance_criteria.some(
    (item) => item.verification !== "manual" && item.verification !== "visual",
  );
  if (needsTests && !plan.verification.commands.some((item) => item.kind === "test" || item.kind === "e2e")) {
    problems.push("Acceptance criteria need automated checks, so the plan needs a test or e2e command.");
  }
  for (const command of plan.verification.commands) {
    if (runsInstallScripts(command.command) && !plan.verification.install_scripts_reason) {
      problems.push(
        `${command.name} runs package install scripts. Add --ignore-scripts, or set install_scripts_reason.`,
      );
    }
    if ((command.kind === "test" || command.kind === "e2e") && hidesGoSkips(command.command)) {
      problems.push(
        `${command.name} runs go test without -v. Go then prints the same line for a package whose tests were all skipped and one that passed, so add -v.`,
      );
    }
    try {
      assertLocalEnv(
        command,
        plan.verification.services.map((item) => item.name),
      );
    } catch (error) {
      problems.push("Commands can reach this machine and verification.services, and nothing else.");
      problems.push((error as Error).message);
    }
  }
  return problems;
}

export function approvalSummary(session: Session): string {
  const plan = session.plan!;
  const { license, security, trace } = session;
  const left = leftOutOf(session, planRefs(plan));
  const repo = session.repoScan?.security;
  const lines = [
    `Feature: ${session.spec!.name}`,
    `Source: ${session.source.url} @ ${session.source.sha.slice(0, 12)}`,
    `License: ${license.source.spdx ?? "none detected"} -> verdict ${license.verdict}`,
    ...license.conditions.map((item) => `  condition: ${item}`),
    `Security scan of selected files: ${security.risk} (${security.counts.critical} critical, ${security.counts.high} high)`,
    ...(left.files.length > 0 || left.cut
      ? [
          `Security scan of the whole repository: ${repo?.risk ?? "unknown"} (${repo?.counts.critical ?? 0} critical, ${repo?.counts.high ?? 0} high)`,
          `Left out of this plan: ${leftOutText(left) || "nothing named"}`,
          `Reason for leaving them out: ${plan.out_of_scope_reason ?? "none given"}`,
          ...(left.cut ? [left.cut] : []),
        ]
      : []),
    "Acceptance criteria:",
    ...session.spec!.acceptance_criteria.map((item) => `  ${item.id} (${item.verification}): ${item.then}`),
    `Files: ${plan.files.filter((file) => file.action === "create").length} to create, ${plan.files.filter((file) => file.action === "modify").length} to modify`,
    ...plan.files.map((file) => `  ${file.action} ${file.path}`),
    `Packages to add: ${plan.dependencies.add.map((dep) => `${dep.name}@${dep.version}`).join(", ") || "none"}`,
    `Migrations: ${plan.migrations.map((item) => `${item.path}${item.destructive ? " (DESTRUCTIVE)" : ""}${item.reversible ? "" : " (IRREVERSIBLE)"}`).join(", ") || "none"}`,
    `Env vars: ${plan.env_vars.map((item) => item.name).join(", ") || "none"}`,
    "Commands that will run:",
    ...plan.verification.commands.map((item) => {
      const env = Object.entries(item.env).map(([key, value]) => `${key}=${value}`);
      return `  [${item.kind}] ${env.length > 0 ? `${env.join(" ")} ` : ""}${item.command}`;
    }),
    ...plan.verification.services.map(
      (item) => `Service on a private network: ${item.name} (${item.image}), check: ${item.ready_command}`,
    ),
    ...narrowedChecks(plan).map((command) => `Runs only part of the test suite: ${command}`),
    ...(needsBrowserCheck(plan)
      ? [`No check here opens the feature in a real browser: ${plan.verification.no_browser_check_reason}`]
      : []),
    ...(plan.verification.install_scripts_reason
      ? [`Package install scripts will run: ${plan.verification.install_scripts_reason}`]
      : []),
    `Isolation: ${plan.verification.docker_image ? `docker (${plan.verification.docker_image}), on a copy of the worktree` : "none. Commands run on this machine with a reduced environment and a temporary HOME, and can still read your files and use the network"}`,
    `Base commit: ${session.target.baseSha?.slice(0, 12)} (${session.target.baseRef})`,
    ...(plan.sensitive_paths_reason ? [`Touches sensitive paths: ${plan.sensitive_paths_reason}`] : []),
    `Risks: ${plan.risks.join("; ") || "none listed"}`,
    ...(session.workspace
      ? [`This replaces an approved plan. The work so far stays in ${session.workspace.path}.`]
      : []),
    `Backend: ${trace?.backend.routes.length ?? 0} routes, ${trace?.backend.migrations.length ?? 0} source migrations traced`,
  ];
  return lines.join("\n");
}

export async function recordPlan(config: Config, id: string, rawPlan: unknown): Promise<Session> {
  const session = await loadSession(config, id);
  requireStage(session, "specified", "Recording the plan");
  if (session.stage === "reported") {
    throw new TransplantError("already_reported", "The report is written. Start a new session to change it.");
  }
  const plan = TransplantPlan.parse(rawPlan);
  const problems = validatePlan(plan, session.spec!);
  const snapshot = await sourceSnapshot(config, session);
  await canonicalRefs(snapshot.analysisRoot, snapshot.subdir, plan, problems);
  // A session from before this check has no whole-repository result, and that must not read as nothing found.
  session.repoScan ??= await scanWhole(
    config,
    snapshot,
    session.target.path,
    session.license.target.distribution,
  );
  const refs = planRefs(plan);
  const barred = refs.filter((ref) => session.repoScan!.security.do_not_copy.includes(ref));
  if (barred.length > 0 && !plan.sensitive_paths_reason) {
    problems.push(
      `These are agent settings or binaries, which stay out of a transplant: ${barred.join(", ")}. Drop the reference, or set sensitive_paths_reason.`,
    );
  }
  const left = leftOutOf(session, refs);
  if ((left.files.length > 0 || left.cut) && !plan.out_of_scope_reason?.trim()) {
    const named = left.files.length > 0 ? `: ${leftOutText(left)}` : "";
    problems.push(
      `The whole-repository scan flags files this plan leaves out${named}. Trace those files with transplant_trace if the feature uses them. Otherwise set out_of_scope_reason to say why it does not.${left.cut ? ` ${left.cut}` : ""}`,
    );
  }
  if (problems.length > 0) {
    throw new TransplantError("invalid_plan", "The plan failed validation.", problems.join("\n"), problems);
  }
  // Files the plan cites join the selection, so approval gates on what they contain.
  const scan = await scanSelection(config, snapshot, session, [...selectedOf(session.trace!), ...refs]);
  session.security = scan.security;
  session.license = scan.license;
  // A plan can turn out wrong once the work starts. The worktree stays, but nothing proven under the old
  // plan carries over, and no edits or checks run until the user approves the new one.
  if (session.workspace) {
    await deleteRunFiles(config, id);
    session.audit = undefined;
    session.verifications = [];
    session.evidence = [];
    session.acknowledgements = {};
    session.baseline = undefined;
  } else {
    // The base commit is part of what gets approved, because unapproved work in it would escape the audit.
    session.target.baseSha = await resolveCommit(session.target.path, session.target.baseRef);
  }
  session.plan = plan;
  session.planHash = sha256(
    canonicalJson({ spec: session.spec, plan, baseSha: session.target.baseSha }),
  ).slice(0, 16);
  session.approval = undefined;
  session.stage = "planned";
  await saveSession(config, session);
  return session;
}

export interface ApproveInput {
  plan_hash: string;
  user_confirmation: string;
  license_override?: string;
  security_override?: string;
  via: "elicitation" | "agent_attested";
}

export async function approvePlan(config: Config, id: string, input: ApproveInput): Promise<Session> {
  const session = await loadSession(config, id);
  requireStage(session, "planned", "Approval");
  if (ORDER.indexOf(session.stage) > ORDER.indexOf("approved")) {
    throw new TransplantError("already_implementing", "Implementation has already started.");
  }
  if (input.plan_hash !== session.planHash) {
    throw new TransplantError(
      "stale_plan",
      "That hash does not match the current plan.",
      `Current hash: ${session.planHash}`,
    );
  }
  if (session.license.verdict === "block" && !input.license_override) {
    throw new TransplantError(
      "license_blocked",
      `License gate: ${session.license.reasons[0]}`,
      "Stop and tell the user. Only they can accept this, and license_override must quote why, such as written permission.",
    );
  }
  if (session.license.verdict === "needs_review" && !input.license_override) {
    throw new TransplantError(
      "license_review_required",
      `License needs review: ${session.license.reasons[0]}`,
      "Tell the user, and pass their decision as license_override.",
    );
  }
  if (session.security.risk === "dangerous" && !input.security_override) {
    throw new TransplantError(
      "security_blocked",
      `Security gate: ${session.security.counts.critical} critical findings in the selected files.`,
      "Show them to the user. If they are false positives, pass the user's decision as security_override.",
    );
  }
  session.approval = {
    at: new Date().toISOString(),
    via: input.via,
    confirmation: input.user_confirmation,
    planHash: input.plan_hash,
    licenseOverride: input.license_override,
    securityOverride: input.security_override,
  };
  if (session.approvedPlans?.at(-1) !== input.plan_hash) {
    session.approvedPlans = [...(session.approvedPlans ?? []), input.plan_hash];
  }
  session.stage = session.workspace ? "implementing" : "approved";
  await saveSession(config, session);
  return session;
}

/** Remembers a person's no, so the agent cannot follow it with its own yes. */
export async function recordRefusal(config: Config, id: string, planHash: string): Promise<void> {
  const session = await loadSession(config, id);
  session.refusedPlans = [...(session.refusedPlans ?? []), planHash];
  await saveSession(config, session);
}

export async function openWorkspace(config: Config, id: string): Promise<Session> {
  const session = await loadSession(config, id);
  requireStage(session, "approved", "Creating the workspace");
  if (session.workspace) return session;
  session.workspace = await createWorkspace(session.target.path, session.id, session.target.baseSha!, {
    root: config.worktreeRoot,
    settings: session.target.settings,
  });
  session.stage = "implementing";
  await saveSession(config, session);
  return session;
}

function requireWorkspace(session: Session, action: string): NonNullable<Session["workspace"]> {
  requireStage(session, "implementing", action);
  if (!session.workspace)
    throw new TransplantError("no_workspace", "Call transplant_create_workspace first.");
  return session.workspace;
}

async function sourceSnapshot(config: Config, session: Session): Promise<Snapshot> {
  return loadSnapshot(session.source.snapshotId, config);
}

export async function auditSession(
  config: Config,
  id: string,
  acknowledge: { finding_id: string; reason: string }[] = [],
  via: "elicitation" | "agent_attested" = "agent_attested",
): Promise<{ session: Session; blocking: number }> {
  const session = await loadSession(config, id);
  const workspace = requireWorkspace(session, "Auditing");
  const label = via === "elicitation" ? "confirmed in the client dialog" : "recorded by the agent";
  for (const item of acknowledge) {
    if (!session.audit?.findings.some((finding) => finding.id === item.finding_id)) {
      throw new TransplantError("unknown_finding", `No finding ${item.finding_id} in the last audit.`);
    }
    session.acknowledgements[item.finding_id] = `${item.reason} (${label})`;
  }
  const snapshot = await sourceSnapshot(config, session);
  const left = leftOutOf(session, planRefs(session.plan!));
  const result = await auditWorkspace(
    workspace,
    session.plan!,
    snapshot.analysisRoot,
    session.acknowledgements,
    {
      leftOut: left.files.flatMap((item) => analysisPath(item.path, session.source.subdir) ?? []),
      license: session.license,
    },
  );
  session.audit = {
    fingerprint: result.fingerprint,
    at: new Date().toISOString(),
    findings: result.findings,
    metrics: result.metrics,
  };
  await saveSession(config, session);
  return { session, blocking: result.blocking.length };
}

export async function verifySession(
  config: Config,
  id: string,
  options: { only?: string[]; continueOnFailure?: boolean; provisional?: boolean; signal?: AbortSignal },
): Promise<{ session: Session; results: Awaited<ReturnType<typeof runVerification>> }> {
  const session = await loadSession(config, id);
  const workspace = requireWorkspace(session, "Verification");
  const results = await runVerification({
    plan: session.plan!,
    workspace,
    logDir: path.join(sessionDir(config, id), "logs"),
    runRoot: runRoot(config, id),
    only: options.only,
    continueOnFailure: options.continueOnFailure,
    provisional: options.provisional,
    baseline: session.baseline?.commands,
    signal: options.signal,
  });
  if (options.provisional) return { session, results };
  for (const { output_tail: _tail, ...run } of results) session.verifications.push(run);
  await saveSession(config, session);
  return { session, results };
}

/** Learns which checks already fail without this work. */
export async function baselineSession(config: Config, id: string, signal?: AbortSignal): Promise<Session> {
  const session = await loadSession(config, id);
  const workspace = requireWorkspace(session, "The baseline");
  const commands = await runBaseline({
    plan: session.plan!,
    workspace,
    logDir: path.join(sessionDir(config, id), "logs"),
    runRoot: runRoot(config, id),
    signal,
  });
  session.baseline = { at: new Date().toISOString(), commands };
  await saveSession(config, session);
  return session;
}

/** Holds a test claim to a passing test run of the current code whose output really names that test. */
async function assertTestEvidence(session: Session, item: EvidenceInput, fingerprint: string): Promise<void> {
  const id = item.acceptance_criterion;
  if (item.kind !== "test" || !item.command_name || !item.log_contains) {
    throw new TransplantError(
      "evidence_incomplete",
      `${id}: this needs test evidence with command_name and log_contains.`,
      "Point at the verification run and the test name in its log.",
    );
  }
  const quoted = item.log_contains.trim();
  if (quoted.length < MIN_EVIDENCE_TEXT || REPORTER_WORD.test(quoted)) {
    throw new TransplantError("evidence_invalid", `${id}: log_contains is too short to identify a test.`);
  }
  const run = session.verifications.filter((entry) => entry.name === item.command_name).at(-1);
  if (!run) throw new TransplantError("evidence_invalid", `No run recorded for ${item.command_name}.`);
  if (run.kind !== "test" && run.kind !== "e2e") {
    throw new TransplantError(
      "evidence_invalid",
      `${item.command_name} is a ${run.kind} command, not a test run.`,
    );
  }
  if (run.status !== "passed" && run.status !== "known_failures") {
    throw new TransplantError("evidence_invalid", `${item.command_name} did not pass (${run.status}).`);
  }
  if (run.failures?.some((name) => name.includes(quoted) || quoted.includes(name))) {
    throw new TransplantError("evidence_invalid", `${id}: "${quoted}" failed in that run.`);
  }
  if (run.fingerprint !== fingerprint) {
    throw new TransplantError(
      "evidence_stale",
      `The code changed after ${item.command_name} ran.`,
      "Run transplant_verify again.",
    );
  }
  if (run.command.includes(quoted)) {
    throw new TransplantError("evidence_invalid", `${id}: log_contains quotes the command, not a test.`);
  }
  const log = (await readText(run.log_path, 25 * 1024 * 1024)) ?? "";
  // The first line echoes the command. Only what the command printed counts.
  const mentions = stripAnsi(log.slice(log.indexOf("\n") + 1))
    .split("\n")
    .filter((line) => line.includes(quoted));
  if (mentions.length === 0) {
    throw new TransplantError(
      "evidence_invalid",
      `"${quoted}" is not in the ${item.command_name} log.`,
      "Use a verbose reporter so test names appear, then quote one exactly.",
    );
  }
  if (mentions.every((line) => SKIPPED_TEST_LINE.test(line))) {
    throw new TransplantError(
      "evidence_invalid",
      `${id}: "${quoted}" was skipped in that run, so it proves nothing.`,
      "Make the test run, or report the criterion as failed.",
    );
  }
}

/** Screenshots are checked by their bytes, since a path or a note in the evidence proves nothing alone. */
async function assertScreenshot(session: Session, workspace: Workspace, item: EvidenceInput): Promise<void> {
  const id = item.acceptance_criterion;
  if (!item.screenshot_path) {
    throw new TransplantError("evidence_incomplete", `${id}: this needs screenshot_path.`);
  }
  const file = path.resolve(workspace.path, item.screenshot_path);
  const head = await readFile(file).then(
    (bytes) => bytes.subarray(0, 12),
    () => null,
  );
  const isImage =
    head !== null &&
    (head.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47])) ||
      head.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff])) ||
      (head.toString("latin1", 0, 4) === "RIFF" && head.toString("latin1", 8, 12) === "WEBP"));
  if (!isImage) {
    throw new TransplantError(
      "evidence_invalid",
      `${id}: ${item.screenshot_path} is not a PNG, JPEG or WebP.`,
    );
  }
  // Whatever it shows, an image from before this work was approved cannot show this work.
  const taken = (await stat(file)).mtimeMs;
  if (session.approval && taken < Date.parse(session.approval.at)) {
    throw new TransplantError("evidence_invalid", `${id}: ${item.screenshot_path} is older than this work.`);
  }
}

export async function recordEvidence(config: Config, id: string, items: EvidenceInput[]): Promise<Session> {
  const session = await loadSession(config, id);
  const workspace = requireWorkspace(session, "Recording evidence");
  const fingerprint = await workspaceFingerprint(workspace);
  const known = new Map(session.spec!.acceptance_criteria.map((item) => [item.id, item]));
  for (const item of items) {
    const criterion = known.get(item.acceptance_criterion);
    if (!criterion)
      throw new TransplantError(
        "unknown_criterion",
        `Unknown acceptance criterion: ${item.acceptance_criterion}`,
      );
    const automated = !["manual", "visual"].includes(criterion.verification);
    if (item.status === "manual_required" && automated) {
      throw new TransplantError(
        "evidence_invalid",
        `${item.acceptance_criterion} requires ${criterion.verification} verification, so it cannot be left to a person.`,
        "Add a test. If that is impossible, report the transplant as incomplete.",
      );
    }
    if (item.status === "pass") {
      // Only a person can pass a manual check, so an agent's note or test leaves it open for them.
      if (criterion.verification === "manual") {
        throw new TransplantError(
          "evidence_invalid",
          `${item.acceptance_criterion} is checked by a person, so record it as manual_required.`,
        );
      }
      if (criterion.verification !== "visual") {
        await assertTestEvidence(session, item, fingerprint);
      } else if (item.kind !== "screenshot") {
        throw new TransplantError("evidence_invalid", `${item.acceptance_criterion} needs a screenshot.`);
      } else {
        await assertScreenshot(session, workspace, item);
      }
    }
    session.evidence.push({ ...item, fingerprint, at: new Date().toISOString() });
  }
  await saveSession(config, session);
  return session;
}

export async function sessionCompletion(session: Session): Promise<CompletionState> {
  return completionState(session, await workspaceFingerprint(session.workspace!));
}

export async function reportSession(config: Config, id: string, allowIncomplete: boolean) {
  const session = await loadSession(config, id);
  const workspace = requireWorkspace(session, "Reporting");
  if (workspace.commit) {
    throw new TransplantError(
      "already_committed",
      "This work is committed. Start a new session to change it.",
    );
  }
  const review = await reviewTree(workspace);
  const state = completionState(session, review.fingerprint);
  if (state.blockers.length > 0 && !allowIncomplete) {
    throw new TransplantError(
      "not_complete",
      `${state.blockers.length} items stop this transplant from being complete.`,
      state.blockers.join("\n"),
      state.blockers,
    );
  }
  const snapshot = await sourceSnapshot(config, session);
  const result = await writeReport(session, snapshot.root, state, config.maxFileBytes, review.changed);
  workspace.toolFiles = await recordToolFiles(workspace, { notices: result.status === "complete" });
  // Everything above took time, so the files are read again before the report vouches for them.
  const tool = new Set(toolPaths(workspace));
  const listing = (files: { path: string; hash: string }[]): string =>
    canonicalJson(files.filter((file) => !tool.has(file.path)).map((file) => [file.path, file.hash]));
  if (listing(review.files) !== listing((await reviewTree(workspace)).files)) {
    // What was written is the tool's own, and the next audit should not take it for the agent's.
    await saveSession(config, session);
    throw new TransplantError(
      "workspace_changed",
      "The worktree changed while the report was being written.",
      "Run transplant_audit, transplant_verify, transplant_record_evidence and transplant_report again.",
    );
  }
  session.report = {
    status: result.status,
    path: result.report_path,
    provenancePath: result.provenance_path,
    at: new Date().toISOString(),
    fingerprint: state.fingerprint,
  };
  session.report.finalFingerprint = await workspaceFingerprint(workspace);
  session.stage = "reported";
  await saveSession(config, session);
  // Installed packages take hundreds of megabytes, and a finished session never needs them again.
  if (result.status === "complete") await deleteRunFiles(config, id).catch(() => undefined);
  return { session, result, state };
}

/** Commits exactly what the report covers. Only for when the user asks. */
export async function commitSession(
  config: Config,
  id: string,
  message: string,
  options: { includeRecords: boolean } = { includeRecords: true },
): Promise<Session> {
  const session = await loadSession(config, id);
  const workspace = requireWorkspace(session, "Committing");
  if (workspace.commit) return session;
  // A commit made earlier whose save failed. It was built from the reviewed files, so it stands.
  if (workspace.pendingCommit && (await branchTip(workspace)) === workspace.pendingCommit) {
    workspace.commit = workspace.pendingCommit;
    await saveSession(config, session);
    return session;
  }
  if (session.report?.status !== "complete") {
    throw new TransplantError("not_complete", "Only a complete report can be committed this way.");
  }
  const reported = session.report.at;
  const newerRun = session.verifications.find(
    (run) => run.at > reported && run.status !== "passed" && run.status !== "known_failures",
  );
  const newerFailure = session.evidence.find((item) => (item.at ?? "") > reported && item.status === "fail");
  if (newerRun || newerFailure) {
    throw new TransplantError(
      "not_complete",
      `${newerRun ? `Verification ${newerRun.name} ${newerRun.status}` : `${newerFailure!.acceptance_criterion} failed`} after the report.`,
      "Fix it, then report again.",
    );
  }
  const review = await reviewTree(workspace);
  if (review.fingerprint !== session.report.finalFingerprint) {
    throw new TransplantError(
      "stale_review",
      "The worktree changed after the report.",
      "Run transplant_audit, transplant_verify, transplant_record_evidence and transplant_report again.",
    );
  }
  const sha = await buildReviewedCommit(session.target.path, workspace, review, message, options);
  workspace.pendingCommit = sha;
  await saveSession(config, session);
  await landCommit(workspace, sha);
  workspace.commit = sha;
  await saveSession(config, session).catch((error: unknown) => {
    throw new TransplantError(
      "session_not_saved",
      `Commit ${sha} is on the branch, but the session could not be saved: ${String(error)}`,
      "Call transplant_commit again to record it.",
    );
  });
  return session;
}

/** Removes the worktree and branch once the commit is in the target. */
export async function cleanupSession(config: Config, id: string, force: boolean): Promise<Session> {
  const session = await loadSession(config, id);
  const workspace = requireWorkspace(session, "Cleanup");
  // A branch still at its base holds nothing yet, and it would count as merged.
  const tip = workspace.commit ?? (await branchTip(workspace));
  const merged = tip !== workspace.baseSha && (await isMerged(session.target.path, tip));
  if (!merged && !force) {
    throw new TransplantError(
      "not_merged",
      "The work is not merged, so removing the worktree would lose it.",
      "Merge it first, or use transplant_discard.",
    );
  }
  await removeWorkspace(session.target.path, workspace, { deleteBranch: true, root: config.worktreeRoot });
  await deleteRunFiles(config, id);
  session.stage = "discarded";
  await saveSession(config, session);
  return session;
}

export async function discardSession(config: Config, id: string): Promise<Session> {
  const session = await loadSession(config, id);
  if (session.workspace) {
    await removeWorkspace(session.target.path, session.workspace, {
      deleteBranch: true,
      root: config.worktreeRoot,
    });
  }
  await deleteSessionFiles(config, id);
  session.stage = "discarded";
  await saveSession(config, session);
  return session;
}
