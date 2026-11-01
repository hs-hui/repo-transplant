import type { LicenseReport } from "./license.js";
import type { SecurityReport } from "./security.js";
import type { StackComparison } from "./stack.js";
import type { TraceResult } from "./trace.js";

export interface Feasibility {
  difficulty: "low" | "medium" | "high" | "very_high";
  score: number;
  go: boolean;
  blockers: string[];
  risks: string[];
  factors: { factor: string; points: number; detail: string }[];
  estimated_change: { files_to_create: number; files_to_wire: number; packages_to_add: number };
  method_note: string;
}

/** Rule-based estimate. Every point is listed in `factors` so a person can check the reasoning. */
export function assessFeasibility(
  trace: TraceResult,
  stack: StackComparison,
  license: LicenseReport,
  security: SecurityReport,
): Feasibility {
  const factors: Feasibility["factors"] = [];
  const add = (factor: string, points: number, detail: string): void => {
    if (points > 0) factors.push({ factor, points, detail });
  };
  const blockers: string[] = [];
  const risks: string[] = [];
  const backend = trace.backend;

  const fileCount = trace.totals.files;
  add(
    "size",
    fileCount > 100 ? 30 : fileCount > 40 ? 20 : fileCount > 15 ? 10 : fileCount > 5 ? 4 : 0,
    `${fileCount} files in the closure`,
  );
  add(
    "shared_infrastructure",
    Math.min(12, trace.shared_infrastructure.length * 2),
    `${trace.shared_infrastructure.length} shared modules to map`,
  );
  add(
    "integration",
    Math.min(10, trace.integration_points.length),
    `${trace.integration_points.length} entry points to wire`,
  );

  if (stack.cross_language) add("cross_language", 30, "Language changes between repositories");
  else if (stack.cross_framework) add("cross_framework", 18, "Framework changes between repositories");
  const differing = stack.differences.filter((row) => row.status === "different").length;
  add("stack_differences", Math.min(12, differing * 3), `${differing} categories differ`);

  const conflicts = stack.dependency_decisions.filter((item) => item.action === "version_conflict");
  const additions = stack.dependency_decisions.filter((item) => item.action === "add");
  add(
    "version_conflicts",
    Math.min(12, conflicts.length * 4),
    conflicts.map((item) => item.package).join(", "),
  );
  add("new_packages", Math.min(8, additions.length), additions.map((item) => item.package).join(", "));

  add("routes", Math.min(10, backend.routes.length), `${backend.routes.length} API routes`);
  add(
    "data_model",
    Math.min(14, backend.data.length * 3 + (backend.migrations.length > 0 ? 3 : 0)),
    `${backend.data.length} models, ${backend.migrations.length} migrations`,
  );
  add("jobs", Math.min(8, backend.jobs.length * 3), `${backend.jobs.length} background job sites`);
  add("realtime", Math.min(8, backend.realtime.length * 3), `${backend.realtime.length} realtime sites`);
  add(
    "external_services",
    Math.min(9, backend.external_services.length * 3),
    backend.external_services.map((item) => item.service).join(", "),
  );
  add(
    "secrets",
    Math.min(6, backend.env_vars.filter((item) => item.likely_secret).length * 2),
    "Secrets to provision",
  );

  if (license.verdict === "block") blockers.push(`License: ${license.reasons[0]}`);
  if (license.verdict === "needs_review") risks.push(`License needs review: ${license.reasons[0]}`);
  if (security.risk === "dangerous")
    blockers.push(`Security scan found ${security.counts.critical} critical findings in the selected files.`);
  if (security.risk === "caution")
    risks.push(`Security scan found ${security.counts.high} high findings. Read them first.`);
  if (trace.truncated)
    risks.push(
      "The trace hit a limit, so the closure may be incomplete. Narrow the seeds or raise the limit.",
    );
  if (trace.unresolved.length > 0) risks.push(`${trace.unresolved.length} imports could not be resolved.`);
  if (backend.has_backend && backend.routes.some((route) => !route.auth_hint)) {
    risks.push(
      "Some routes show no authentication hint. Record the real auth rule for every route in the spec.",
    );
  }
  if (backend.migrations.length > 0)
    risks.push("The feature carries schema changes. Write a new reversible migration in the target.");
  for (const conflict of conflicts) risks.push(`${conflict.package}: ${conflict.note}`);

  const score = Math.min(
    100,
    factors.reduce((sum, item) => sum + item.points, 0),
  );
  const difficulty = score >= 70 ? "very_high" : score >= 45 ? "high" : score >= 20 ? "medium" : "low";
  return {
    difficulty,
    score,
    go: blockers.length === 0,
    blockers,
    risks,
    factors: factors.sort((a, b) => b.points - a.points),
    estimated_change: {
      files_to_create: trace.files.filter((file) => file.file_class !== "asset").length,
      files_to_wire: trace.integration_points.length,
      packages_to_add: additions.length,
    },
    method_note: "Rule-based score out of 100. It ranks effort and risk, and it is not a time estimate.",
  };
}
