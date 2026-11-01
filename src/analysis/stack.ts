import semver from "semver";
import { type Category, TECHNOLOGIES, technologiesFor } from "./catalog.js";
import type { Dependency, Ecosystem } from "./manifests.js";
import type { RepoProfile } from "./profile.js";

export type DependencyAction =
  | "reuse_installed"
  | "reuse_equivalent"
  | "add"
  | "version_conflict"
  | "drop_candidate";

export interface DependencyDecision {
  package: string;
  ecosystem: Ecosystem;
  action: DependencyAction;
  source_version: string | null;
  target_version: string | null;
  note: string;
}

export interface CategoryDifference {
  category: Category;
  source: string[];
  target: string[];
  status: "same" | "different" | "source_only" | "target_only";
  guidance: string;
}

export interface StackComparison {
  cross_framework: boolean;
  cross_language: boolean;
  differences: CategoryDifference[];
  dependency_decisions: DependencyDecision[];
  adaptation_notes: string[];
}

const GUIDANCE: Partial<Record<Category, string>> = {
  ui_framework:
    "Rebuild components from the behavior spec in the target framework. Do not translate line by line.",
  meta_framework: "Move routing, data loading and server boundaries to the target's conventions.",
  backend_framework: "Re-express handlers, middleware order and error shapes in the target framework.",
  state: "Re-express stores with the target's state library and keep the same state transitions.",
  styling: "Rewrite styles with the target's tokens. Do not bring the source's styling library along.",
  ui_kit: "Use the target's components for buttons, inputs and dialogs.",
  data_fetching: "Keep cache keys and invalidation rules, written with the target's client.",
  orm: "Write the data model and a new migration with the target's ORM. Never copy source migrations as is.",
  database: "Check column types, transactions and JSON or full-text features for dialect differences.",
  auth: "Connect to the target's existing auth. Never add a second auth system.",
  validation: "Rewrite schemas with the target's validation library at the same trust boundaries.",
  test_runner: "Write tests with the target's runner and layout.",
  queue: "Use the target's queue, and keep the retry and idempotency behavior.",
  cache: "Use the target's cache, and keep the TTL and invalidation behavior.",
  api_style: "Expose the feature through the target's API style and error format.",
};

function differences(source: RepoProfile, target: RepoProfile): CategoryDifference[] {
  const categories = new Set([...Object.keys(source.stack), ...Object.keys(target.stack)]) as Set<Category>;
  const rows: CategoryDifference[] = [];
  for (const category of categories) {
    const sourceValues = source.stack[category] ?? [];
    const targetValues = target.stack[category] ?? [];
    const overlap = sourceValues.some((value) => targetValues.includes(value));
    const status: CategoryDifference["status"] =
      sourceValues.length === 0
        ? "target_only"
        : targetValues.length === 0
          ? "source_only"
          : overlap
            ? "same"
            : "different";
    rows.push({
      category,
      source: sourceValues,
      target: targetValues,
      status,
      guidance:
        status === "same" || status === "target_only"
          ? ""
          : (GUIDANCE[category] ?? "Prefer what the target already uses."),
    });
  }
  const order = { different: 0, source_only: 1, same: 2, target_only: 3 };
  return rows.sort((a, b) => order[a.status] - order[b.status]);
}

function rangesCompatible(ecosystem: Ecosystem, a: string, b: string): boolean | null {
  if (a === "*" || b === "*") return true;
  if (ecosystem === "npm") {
    if (!semver.validRange(a) || !semver.validRange(b)) return null;
    return semver.intersects(a, b);
  }
  if (ecosystem === "go" || ecosystem === "cargo") {
    const major = (value: string): number | undefined => semver.coerce(value)?.major;
    return major(a) === undefined || major(b) === undefined ? null : major(a) === major(b);
  }
  return a === b ? true : null;
}

function normalize(ecosystem: Ecosystem, name: string): string {
  return ecosystem === "pypi" ? name.toLowerCase().replace(/_/g, "-") : name;
}

function decide(
  pkg: string,
  ecosystem: Ecosystem,
  source: Dependency | undefined,
  target: Dependency[],
): DependencyDecision {
  const base = { package: pkg, ecosystem, source_version: source?.version ?? null };
  const installed = target.find(
    (dep) => dep.ecosystem === ecosystem && normalize(ecosystem, dep.name) === normalize(ecosystem, pkg),
  );
  if (installed) {
    const compatible = source ? rangesCompatible(ecosystem, source.version, installed.version) : true;
    if (compatible === false) {
      return {
        ...base,
        action: "version_conflict",
        target_version: installed.version,
        note: `Target pins ${installed.version} while the source needs ${source?.version}. Adapt the code to the target's version. Do not bump it unless the plan says so.`,
      };
    }
    return {
      ...base,
      action: "reuse_installed",
      target_version: installed.version,
      note:
        compatible === null
          ? "Installed. Version compatibility could not be computed, so check the APIs used."
          : "Already installed with a compatible version.",
    };
  }

  for (const tech of technologiesFor(ecosystem, pkg)) {
    const alternatives = TECHNOLOGIES.filter(
      (other) =>
        other.category === tech.category && other.ecosystem === ecosystem && other.name !== tech.name,
    );
    for (const alternative of alternatives) {
      const existing = target.find(
        (dep) => dep.ecosystem === ecosystem && alternative.packages.includes(dep.name),
      );
      if (existing) {
        return {
          ...base,
          action: "reuse_equivalent",
          target_version: existing.version,
          note: `Target already uses ${existing.name} for ${tech.category}. Rewrite against it instead of adding ${pkg}.`,
        };
      }
    }
  }

  return {
    ...base,
    action: "add",
    target_version: null,
    note: "Not in the target. Ask whether the feature really needs it before adding it.",
  };
}

export function compareStacks(
  source: RepoProfile,
  target: RepoProfile,
  requiredPackages?: string[],
): StackComparison {
  const rows = differences(source, target);
  const language = (profile: RepoProfile): Set<string> =>
    new Set(
      profile.languages
        .filter((item) => item.share >= 15 && !["CSS", "SCSS", "HTML", "SQL", "Less"].includes(item.language))
        .map((item) => (item.language === "JavaScript" ? "TypeScript" : item.language)),
    );
  const sourceLanguages = language(source);
  const targetLanguages = language(target);
  const crossLanguage =
    sourceLanguages.size > 0 &&
    targetLanguages.size > 0 &&
    ![...sourceLanguages].some((item) => targetLanguages.has(item));
  const uiRow = rows.find((row) => row.category === "ui_framework");

  const sourceRuntime = source.dependencies.filter((dep) => !dep.dev);
  const wanted = requiredPackages ?? sourceRuntime.map((dep) => dep.name);
  const seen = new Set<string>();
  const decisions: DependencyDecision[] = [];
  for (const pkg of wanted) {
    if (seen.has(pkg)) continue;
    seen.add(pkg);
    const declared = source.dependencies.find(
      (dep) => normalize(dep.ecosystem, dep.name) === normalize(dep.ecosystem, pkg),
    );
    const ecosystem = declared?.ecosystem ?? target.dependencies[0]?.ecosystem ?? "npm";
    decisions.push(decide(pkg, ecosystem, declared, target.dependencies));
  }

  const notes: string[] = [];
  if (crossLanguage) {
    notes.push(
      `Language changes (${[...sourceLanguages].join(", ")} to ${[...targetLanguages].join(", ")}). Treat this as a re-implementation from the spec.`,
    );
  }
  if (uiRow?.status === "different")
    notes.push(`UI framework changes (${uiRow.source.join(", ")} to ${uiRow.target.join(", ")}).`);
  const tc = target.conventions;
  notes.push(
    `Match target conventions: ${tc.indent} indent, ${tc.quotes} quotes, ${tc.exportStyle} exports, tests ${tc.testLayout}, architecture ${tc.architecture.join(", ") || "unspecified"}.`,
  );
  return {
    cross_framework:
      uiRow?.status === "different" ||
      rows.some((row) => row.category === "backend_framework" && row.status === "different"),
    cross_language: crossLanguage,
    differences: rows,
    dependency_decisions: decisions,
    adaptation_notes: notes,
  };
}
