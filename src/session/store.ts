import { readdir, rm } from "node:fs/promises";
import path from "node:path";
import type { LicenseReport } from "../analysis/license.js";
import type { SecurityReport } from "../analysis/security.js";
import type { TraceResult } from "../analysis/trace.js";
import type { Config } from "../config.js";
import { TransplantError } from "../util/errors.js";
import { pathExists, randomId, readJson, writeJsonAtomic } from "../util/fsx.js";
import type { EvidenceInput, FeatureSpec, TransplantPlan } from "./schema.js";
import type { Workspace } from "./workspace.js";

export type Stage =
  | "started"
  | "traced"
  | "specified"
  | "planned"
  | "approved"
  | "implementing"
  | "reported"
  | "discarded";

export interface AuditFinding {
  id: string;
  rule: string;
  severity: "high" | "medium" | "info";
  file: string | null;
  line: number | null;
  message: string;
  acknowledged?: string;
}

export interface BaselineRun {
  name: string;
  status: VerificationRun["status"];
  failures: string[];
  /** How the output ended, without numbers, to recognize the same failure in a build. */
  signature: string;
}

export interface VerificationRun {
  name: string;
  command: string;
  kind: string;
  status: "passed" | "known_failures" | "failed" | "timed_out" | "no_tests_ran" | "modified_files";
  /** Failing test names read from the output. */
  failures?: string[];
  exit_code: number | null;
  duration_ms: number;
  fingerprint: string;
  log_path: string;
  isolation: "host" | "docker";
  at: string;
}

export interface Evidence extends EvidenceInput {
  fingerprint: string;
  at: string;
}

export interface Session {
  id: string;
  createdAt: string;
  updatedAt: string;
  stage: Stage;
  feature: string;
  source: {
    snapshotId: string;
    url: string;
    sha: string;
    ref: string;
    subdir?: string;
  };
  target: {
    path: string;
    headSha: string;
    dirty: boolean;
    baseRef: string;
    baseSha?: string;
    /** Hash of the git settings when the session started. */
    settings?: string;
  };
  license: LicenseReport;
  security: SecurityReport;
  trace?: TraceResult;
  spec?: FeatureSpec;
  plan?: TransplantPlan;
  planHash?: string;
  approval?: {
    at: string;
    via: "elicitation" | "agent_attested";
    confirmation: string;
    planHash: string;
    licenseOverride?: string;
    securityOverride?: string;
  };
  workspace?: Workspace;
  audit?: { fingerprint: string; at: string; findings: AuditFinding[]; metrics: Record<string, unknown> };
  acknowledgements: Record<string, string>;
  /** The plan's commands run on the unchanged base commit, to tell old failures from new ones. */
  baseline?: { at: string; commands: BaselineRun[] };
  /** Every plan hash the user approved, in order. */
  approvedPlans?: string[];
  /** Plans a person refused in a dialog. The agent's word cannot approve these. */
  refusedPlans?: string[];
  verifications: VerificationRun[];
  evidence: Evidence[];
  report?: {
    status: "complete" | "incomplete";
    path: string;
    provenancePath: string;
    at: string;
    fingerprint: string;
    /** The state of the tree once the report's own files are in place. */
    finalFingerprint?: string;
  };
}

function sessionFile(config: Config, id: string): string {
  if (!/^[a-z0-9-]+$/.test(id)) throw new TransplantError("invalid_session", `Invalid session id: ${id}`);
  return path.join(config.sessionsDir, id, "session.json");
}

export const sessionDir = (config: Config, id: string): string => path.join(config.sessionsDir, id);

/** Hex characters at the end of a session id. */
export const SESSION_SUFFIX = 6;

export const newSessionId = (feature: string): string => {
  const slug = feature
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 20)
    .replace(/-+$/, "");
  return `${slug || "feature"}-${randomId(SESSION_SUFFIX / 2)}`;
};

export async function saveSession(config: Config, session: Session): Promise<void> {
  session.updatedAt = new Date().toISOString();
  await writeJsonAtomic(sessionFile(config, session.id), session);
}

export async function loadSession(config: Config, id: string): Promise<Session> {
  const file = sessionFile(config, id);
  if (!(await pathExists(file))) {
    throw new TransplantError(
      "session_not_found",
      `Unknown session: ${id}`,
      "Call transplant_list to see sessions.",
    );
  }
  return readJson<Session>(file);
}

export async function listSessions(config: Config): Promise<Session[]> {
  if (!(await pathExists(config.sessionsDir))) return [];
  const sessions: Session[] = [];
  for (const entry of await readdir(config.sessionsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const file = path.join(config.sessionsDir, entry.name, "session.json");
    if (await pathExists(file)) sessions.push(await readJson<Session>(file));
  }
  return sessions.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
}

/** Kept apart from the session so code under verification has no short path to its own evidence. */
export const runRoot = (config: Config, id: string): string => path.join(config.home, "runs", id);

export async function deleteRunFiles(config: Config, id: string): Promise<void> {
  await rm(runRoot(config, id), { recursive: true, force: true, maxRetries: 3 });
}

export async function deleteSessionFiles(config: Config, id: string): Promise<void> {
  await rm(path.join(sessionDir(config, id), "logs"), { recursive: true, force: true, maxRetries: 3 });
  await deleteRunFiles(config, id);
}

const locks = new Map<string, Promise<unknown>>();

/** Serializes work on one session, since each step reads, changes and rewrites the session file. */
export function withSessionLock<T>(id: string, work: () => Promise<T>): Promise<T> {
  const previous = locks.get(id) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(work);
  const settled = next.catch(() => undefined);
  locks.set(id, settled);
  settled.finally(() => {
    if (locks.get(id) === settled) locks.delete(id);
  });
  return next;
}
