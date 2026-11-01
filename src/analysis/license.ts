import { readdir } from "node:fs/promises";
import path from "node:path";
import { walkRepo } from "../repo/walk.js";
import { parseJsonc, pathExists, readText } from "../util/fsx.js";

export type LicenseClass =
  | "public_domain"
  | "permissive"
  | "weak_copyleft"
  | "strong_copyleft"
  | "network_copyleft"
  | "source_available"
  | "non_commercial"
  | "unknown"
  | "none";

export type LicenseVerdict = "allow" | "allow_with_conditions" | "needs_review" | "block";
export type Distribution = "proprietary" | "open_source" | "internal_only" | "unknown";

const CLASS_BY_ID: Record<string, LicenseClass> = {
  "CC0-1.0": "public_domain",
  Unlicense: "public_domain",
  "0BSD": "public_domain",
  MIT: "permissive",
  "MIT-0": "public_domain",
  ISC: "permissive",
  "BSD-2-Clause": "permissive",
  "BSD-3-Clause": "permissive",
  "Apache-2.0": "permissive",
  Zlib: "permissive",
  "BSL-1.0": "permissive",
  "CC-BY-4.0": "permissive",
  "MPL-2.0": "weak_copyleft",
  "LGPL-2.1": "weak_copyleft",
  "LGPL-3.0": "weak_copyleft",
  "EPL-2.0": "weak_copyleft",
  "CDDL-1.0": "weak_copyleft",
  "GPL-2.0": "strong_copyleft",
  "GPL-3.0": "strong_copyleft",
  "AGPL-3.0": "network_copyleft",
  "SSPL-1.0": "source_available",
  "BUSL-1.1": "source_available",
  "Elastic-2.0": "source_available",
  "FSL-1.1": "source_available",
  "Commons-Clause": "source_available",
  "PolyForm-Noncommercial": "non_commercial",
  "CC-BY-NC-4.0": "non_commercial",
  "CC-BY-NC-SA-4.0": "non_commercial",
};

/**
 * The GNU licenses cite one another: GPL-3 section 13 names the Affero license, and the LGPL builds on
 * the GPL. So they are told apart by the title at the top of the file, never by the whole text.
 */
const GNU_TITLES: { id: string; title: string; version: string }[] = [
  { id: "AGPL-3.0", title: "gnu affero general public license", version: "" },
  { id: "LGPL-3.0", title: "gnu lesser general public license", version: "version 3" },
  { id: "LGPL-2.1", title: "gnu lesser general public license", version: "version 2.1" },
  { id: "GPL-3.0", title: "gnu general public license", version: "version 3" },
  { id: "GPL-2.0", title: "gnu general public license", version: "version 2" },
];

/** Ordered: BSD-3 contains the BSD-2 phrasing. */
const FINGERPRINTS: { id: string; all: string[] }[] = [
  { id: "SSPL-1.0", all: ["server side public license"] },
  { id: "BUSL-1.1", all: ["business source license"] },
  { id: "FSL-1.1", all: ["functional source license"] },
  { id: "Elastic-2.0", all: ["elastic license"] },
  { id: "PolyForm-Noncommercial", all: ["polyform noncommercial license"] },
  { id: "CC-BY-NC-SA-4.0", all: ["attribution-noncommercial-sharealike"] },
  { id: "CC-BY-NC-4.0", all: ["attribution-noncommercial"] },
  { id: "CC-BY-4.0", all: ["creative commons attribution 4.0 international"] },
  { id: "MPL-2.0", all: ["mozilla public license", "version 2.0"] },
  { id: "EPL-2.0", all: ["eclipse public license", "2.0"] },
  { id: "Apache-2.0", all: ["apache license", "version 2.0"] },
  { id: "CC0-1.0", all: ["cc0 1.0 universal"] },
  { id: "Unlicense", all: ["free and unencumbered software released into the public domain"] },
  { id: "BSL-1.0", all: ["boost software license"] },
  { id: "Zlib", all: ["altered source versions must be plainly marked as such"] },
  {
    id: "BSD-3-Clause",
    all: ["redistribution and use in source and binary forms", "neither the name"],
  },
  {
    id: "BSD-2-Clause",
    all: ["redistribution and use in source and binary forms"],
  },
  { id: "MIT", all: ["permission is hereby granted, free of charge", "the software is provided"] },
  { id: "ISC", all: ["permission to use, copy, modify, and", "distribute this software for any purpose"] },
];

const SPDX_ALIASES: Record<string, string> = {
  "APACHE 2.0": "Apache-2.0",
  APACHE2: "Apache-2.0",
  "APACHE-2": "Apache-2.0",
  BSD: "BSD-3-Clause",
  "BSD-3": "BSD-3-Clause",
  "BSD-2": "BSD-2-Clause",
  GPL: "GPL-3.0",
  GPLV3: "GPL-3.0",
  GPLV2: "GPL-2.0",
  AGPL: "AGPL-3.0",
  AGPLV3: "AGPL-3.0",
  LGPL: "LGPL-3.0",
  MPL: "MPL-2.0",
  "THE UNLICENSE": "Unlicense",
};

function normalizeSpdx(raw: string): string {
  const cleaned = raw.trim().replace(/^\(|\)$/g, "");
  const alias = SPDX_ALIASES[cleaned.toUpperCase()];
  if (alias) return alias;
  const base = cleaned.replace(/-(only|or-later)$/i, "").replace(/\+$/, "");
  return Object.keys(CLASS_BY_ID).find((id) => id.toLowerCase() === base.toLowerCase()) ?? base;
}

const RESTRICTIVENESS: LicenseClass[] = [
  "public_domain",
  "permissive",
  "weak_copyleft",
  "unknown",
  "strong_copyleft",
  "network_copyleft",
  "source_available",
  "non_commercial",
  "none",
];

function classify(id: string): LicenseClass {
  return CLASS_BY_ID[id] ?? "unknown";
}

interface Resolved {
  spdx: string;
  rank: number;
}

/** Parses an SPDX expression by precedence: AND binds tighter than OR, and parentheses override both. */
function parseExpression(expression: string): Resolved {
  const tokens = expression.match(/[()]|[^\s()]+/g) ?? [];
  let position = 0;
  const leaf = (raw: string): Resolved => {
    const spdx = normalizeSpdx(raw);
    return { spdx, rank: RESTRICTIVENESS.indexOf(classify(spdx)) };
  };
  const primary = (): Resolved => {
    const token = tokens[position++] ?? "";
    if (token === "(") {
      const inner = orExpression();
      position++;
      return inner;
    }
    // WITH adds an exception to a license and does not change its class here.
    if (tokens[position]?.toUpperCase() === "WITH") position += 2;
    return leaf(token);
  };
  const andExpression = (): Resolved => {
    let left = primary();
    while (tokens[position]?.toUpperCase() === "AND") {
      position++;
      const right = primary();
      left = right.rank > left.rank ? right : left;
    }
    return left;
  };
  const orExpression = (): Resolved => {
    let left = andExpression();
    while (tokens[position]?.toUpperCase() === "OR") {
      position++;
      const right = andExpression();
      left = right.rank < left.rank ? right : left;
    }
    return left;
  };
  return orExpression();
}

/** Resolves an SPDX expression: OR takes the most permissive branch, AND the most restrictive. */
export function resolveExpression(expression: string): { spdx: string; class: LicenseClass } {
  const { spdx } = parseExpression(expression);
  return { spdx, class: classify(spdx) };
}

function expressionLeaves(expression: string): string[] {
  return (expression.match(/[^\s()]+/g) ?? [])
    .filter((token) => !/^(AND|OR|WITH)$/i.test(token))
    .map(normalizeSpdx);
}

export function identifyLicenseText(text: string): string | null {
  const normalized = text
    .toLowerCase()
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/\s+/g, " ");
  const head = normalized.slice(0, 600);
  for (const { id, title, version } of GNU_TITLES) {
    if (head.includes(title) && head.includes(version)) return id;
  }
  for (const fingerprint of FINGERPRINTS) {
    if (fingerprint.all.every((phrase) => normalized.includes(phrase))) return fingerprint.id;
  }
  return null;
}

export interface LicenseInfo {
  spdx: string | null;
  class: LicenseClass;
  evidence: { kind: string; path: string; value: string }[];
  license_file: string | null;
  notice_file: string | null;
  copyright: string[];
  commons_clause: boolean;
  /** The license text and the package manifest disagree. A person has to settle which applies. */
  conflict: string | null;
}

const LICENSE_FILE = /^(LICEN[CS]E|COPYING|UNLICENSE)([.-][A-Za-z0-9.-]+)?(\.(md|txt|rst))?$/i;

async function declaredLicenses(
  repoRoot: string,
  relDir: string,
  maxBytes: number,
): Promise<{ path: string; value: string }[]> {
  const root = path.join(repoRoot, relDir);
  const label = (file: string): string => (relDir ? `${relDir}/${file}` : file);
  const found: { path: string; value: string }[] = [];
  const pkgText = await readText(path.join(root, "package.json"), maxBytes);
  const pkg = pkgText ? parseJsonc<{ license?: string | { type?: string } }>(pkgText) : null;
  const pkgLicense = typeof pkg?.license === "string" ? pkg.license : pkg?.license?.type;
  if (pkgLicense) found.push({ path: label("package.json"), value: pkgLicense });

  for (const [file, pattern] of [
    ["pyproject.toml", /^license\s*=\s*(?:\{\s*text\s*=\s*)?"([^"]+)"/m],
    ["Cargo.toml", /^license\s*=\s*"([^"]+)"/m],
  ] as const) {
    const text = await readText(path.join(root, file), maxBytes);
    const match = text?.match(pattern);
    if (match) found.push({ path: label(file), value: match[1]! });
  }
  const composerText = await readText(path.join(root, "composer.json"), maxBytes);
  const composer = composerText ? parseJsonc<{ license?: string }>(composerText) : null;
  if (typeof composer?.license === "string")
    found.push({ path: label("composer.json"), value: composer.license });
  return found;
}

/** Detects the license governing `dir`, walking up to the root so a nested LICENSE wins in monorepos. */
export async function detectLicense(root: string, dir: string, maxBytes: number): Promise<LicenseInfo> {
  const info: LicenseInfo = {
    spdx: null,
    class: "none",
    evidence: [],
    license_file: null,
    notice_file: null,
    copyright: [],
    commons_clause: false,
    conflict: null,
  };
  const chain: string[] = [];
  let current = dir === "." ? "" : dir;
  while (true) {
    chain.push(current);
    if (!current) break;
    current = path.posix.dirname(current) === "." ? "" : path.posix.dirname(current);
  }

  const textIds: string[] = [];
  for (const relDir of chain) {
    const absolute = path.join(root, relDir);
    if (!(await pathExists(absolute))) continue;
    const entries = (await readdir(absolute, { withFileTypes: true })).sort((a, b) =>
      a.name < b.name ? -1 : 1,
    );
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
      if (/^NOTICE(\.[a-z]+)?$/i.test(entry.name) && !info.notice_file) info.notice_file = rel;
      if (!LICENSE_FILE.test(entry.name)) continue;
      const text = await readText(path.join(root, rel), maxBytes);
      if (!text) continue;
      const id = identifyLicenseText(text);
      info.license_file ??= rel;
      if (info.copyright.length === 0) {
        info.copyright = [...text.matchAll(/^.{0,200}copyright\s+(\(c\)|\u00a9|\d{4}).{0,200}$/gim)]
          .map((match) => match[0].trim().slice(0, 200))
          .slice(0, 5);
      }
      if (/commons clause/i.test(text)) info.commons_clause = true;
      info.evidence.push({ kind: "license_text", path: rel, value: id ?? "unrecognized" });
      textIds.push(id ?? "unrecognized");
    }
    if (info.license_file) break;
  }

  // Several texts with no manifest to explain them: assume the strictest applies.
  const known = textIds.filter((id) => id !== "unrecognized");
  const rank = (id: string): number => RESTRICTIVENESS.indexOf(classify(id));
  if (textIds.includes("unrecognized")) {
    info.class = "unknown";
  } else if (known.length > 0) {
    info.spdx = [...known].sort((a, b) => rank(b) - rank(a))[0]!;
    info.class = classify(info.spdx);
  }

  let declared: { path: string; value: string }[] = [];
  for (const relDir of chain) {
    declared = await declaredLicenses(root, relDir, maxBytes);
    if (declared.length > 0) break;
  }
  for (const entry of declared) {
    info.evidence.push({ kind: "manifest", path: entry.path, value: entry.value });
    if (/^(unlicensed|proprietary|see license)/i.test(entry.value)) {
      if (!info.license_file) info.class = "none";
      else if (info.class !== "none")
        info.conflict = `${entry.path} says ${entry.value}, but a license file exists.`;
      continue;
    }
    const resolved = resolveExpression(entry.value);
    if (!info.license_file) {
      info.spdx = resolved.spdx;
      info.class = resolved.class;
      continue;
    }
    if (info.class === "unknown") {
      info.conflict = `${entry.path} says ${entry.value}, but the license file could not be identified.`;
      continue;
    }
    const leaves = expressionLeaves(entry.value);
    if (known.every((id) => leaves.includes(id))) {
      // A dual-licensed manifest explains which of its texts may be chosen.
      info.spdx = resolved.spdx;
      info.class = resolved.class;
    } else {
      info.conflict = `${entry.path} says ${entry.value}, but the license text is ${known.join(", ")}.`;
    }
  }

  if (info.commons_clause) {
    info.spdx = `${info.spdx ?? "unknown"} + Commons-Clause`;
    info.class = "source_available";
  }
  return info;
}

export interface FileLicenseOverride {
  path: string;
  spdx: string;
  class: LicenseClass;
  source: "spdx_header" | "nested_license";
}

const SPDX_HEADER = /SPDX-License-Identifier:\s*([^\r\n*]+)/;

export interface LicenseReport {
  source: LicenseInfo;
  target: LicenseInfo & { distribution: Distribution };
  file_overrides: FileLicenseOverride[];
  verdict: LicenseVerdict;
  conditions: string[];
  reasons: string[];
  disclaimer: string;
}

function attributionConditions(source: LicenseInfo): string[] {
  const conditions: string[] = [];
  if (source.class === "permissive") {
    conditions.push("Keep the copyright notice and license text of the source with the transplanted code.");
  }
  if (source.spdx?.startsWith("Apache-2.0")) {
    conditions.push("Mark modified files as changed.");
    if (source.notice_file) conditions.push(`Carry over the NOTICE file (${source.notice_file}).`);
  }
  return conditions;
}

function judge(
  cls: LicenseClass,
  source: LicenseInfo,
  target: LicenseReport["target"],
): Pick<LicenseReport, "verdict" | "conditions" | "reasons"> {
  const targetCopyleft = target.spdx ?? "";
  const label = source.spdx ?? "no detectable license";
  switch (cls) {
    case "public_domain":
      return { verdict: "allow", conditions: [], reasons: [`${label} places no conditions on reuse.`] };
    case "permissive":
      return {
        verdict: "allow_with_conditions",
        conditions: attributionConditions(source),
        reasons: [`${label} allows reuse with attribution.`],
      };
    case "weak_copyleft":
      if (source.spdx === "MPL-2.0") {
        return {
          verdict: "allow_with_conditions",
          conditions: [
            "Keep MPL-covered code in its own files under MPL-2.0; do not merge it into existing files.",
            "Publish modifications to those files under MPL-2.0 when distributing.",
          ],
          reasons: ["MPL-2.0 is file-level copyleft."],
        };
      }
      return {
        verdict: "needs_review",
        conditions: ["Prefer using the original as a dependency over copying its code."],
        reasons: [`${label} copyleft reaches modified copies of the code.`],
      };
    case "strong_copyleft":
      if (target.class === "strong_copyleft" && targetCopyleft === source.spdx) {
        return {
          verdict: "allow_with_conditions",
          conditions: ["Keep license notices and distribute under the same license."],
          reasons: [`Source and target share ${label}.`],
        };
      }
      if (target.class === "network_copyleft" && source.spdx === "GPL-3.0") {
        return {
          verdict: "needs_review",
          conditions: ["GPL-3.0 and AGPL-3.0 combine only under their section 13 terms."],
          reasons: ["Copyleft families differ."],
        };
      }
      if (target.distribution === "internal_only") {
        return {
          verdict: "needs_review",
          conditions: [
            "Stays compliant only while the software is never distributed outside the organization.",
          ],
          reasons: [`${label} copyleft triggers on distribution.`],
        };
      }
      return {
        verdict: "block",
        conditions: [],
        reasons: [`${label} would require the target to adopt the same license on distribution.`],
      };
    case "network_copyleft":
      if (target.class === "network_copyleft") {
        return {
          verdict: "allow_with_conditions",
          conditions: ["Keep license notices and offer source to network users."],
          reasons: ["Source and target share AGPL-3.0."],
        };
      }
      return {
        verdict: "block",
        conditions: [],
        reasons: [
          "AGPL-3.0 reaches users of a network service, including internal deployments open to outside users.",
        ],
      };
    case "source_available":
    case "non_commercial":
      return {
        verdict: "block",
        conditions: [],
        reasons: [`${label} restricts commercial or competing use.`],
      };
    case "none":
      return {
        verdict: "block",
        conditions: [],
        reasons: ["No license was found. Code without a license is all rights reserved by default."],
      };
    default:
      return {
        verdict: "needs_review",
        conditions: [],
        reasons: [`License could not be identified (${label}). A person has to read it.`],
      };
  }
}

const VERDICT_ORDER: LicenseVerdict[] = ["allow", "allow_with_conditions", "needs_review", "block"];

export interface LicenseCheckOptions {
  paths?: string[];
  subdir?: string;
  distribution?: Distribution;
  maxFileBytes: number;
}

function resolveDistribution(target: LicenseInfo, requested?: Distribution): Distribution {
  if (requested && requested !== "unknown") return requested;
  if (target.class === "none") return "proprietary";
  if (target.class === "unknown") return "unknown";
  return "open_source";
}

/** Compares source and target licenses, including per-file overrides for the selected files. */
export async function checkLicense(
  sourceRoot: string,
  targetRoot: string | null,
  options: LicenseCheckOptions,
): Promise<LicenseReport> {
  const source = await detectLicense(sourceRoot, options.subdir ?? ".", options.maxFileBytes);
  const targetInfo: LicenseInfo = targetRoot
    ? await detectLicense(targetRoot, ".", options.maxFileBytes)
    : {
        spdx: null,
        class: "none",
        evidence: [],
        license_file: null,
        notice_file: null,
        copyright: [],
        commons_clause: false,
        conflict: null,
      };
  const target = { ...targetInfo, distribution: resolveDistribution(targetInfo, options.distribution) };

  const overrides: FileLicenseOverride[] = [];
  const nestedSeen = new Map<string, LicenseInfo>();
  const nestedConflicts = new Set<string>();
  const selected =
    options.paths ??
    (await walkRepo(sourceRoot))
      .filter((file) => file.fileClass === "source")
      .map((file) => file.rel)
      .slice(0, 2000);
  for (const rel of selected) {
    const text = await readText(path.join(sourceRoot, rel), options.maxFileBytes);
    const header = text?.slice(0, 2000).match(SPDX_HEADER);
    if (header) {
      const resolved = resolveExpression(header[1]!.trim());
      if (resolved.spdx !== source.spdx) {
        overrides.push({ path: rel, spdx: resolved.spdx, class: resolved.class, source: "spdx_header" });
      }
      continue;
    }
    if (!options.paths) continue;
    const dir = path.posix.dirname(rel);
    if (!nestedSeen.has(dir)) nestedSeen.set(dir, await detectLicense(sourceRoot, dir, options.maxFileBytes));
    const nested = nestedSeen.get(dir)!;
    if (nested.conflict) nestedConflicts.add(nested.conflict);
    if (nested.license_file && nested.license_file !== source.license_file && nested.spdx !== source.spdx) {
      overrides.push({
        path: rel,
        spdx: nested.spdx ?? "unknown",
        class: nested.class,
        source: "nested_license",
      });
    }
  }

  const base = judge(source.class, source, target);
  let verdict = base.verdict;
  const conditions = [...base.conditions];
  const reasons = [...base.reasons];
  for (const override of overrides) {
    const fileJudgement = judge(override.class, { ...source, spdx: override.spdx }, target);
    if (VERDICT_ORDER.indexOf(fileJudgement.verdict) > VERDICT_ORDER.indexOf(verdict)) {
      verdict = fileJudgement.verdict;
      reasons.push(`${override.path} is under ${override.spdx}, stricter than the repository license.`);
    }
    for (const condition of fileJudgement.conditions) {
      if (!conditions.includes(condition)) conditions.push(condition);
    }
  }
  for (const conflict of [source.conflict, ...nestedConflicts]) {
    if (!conflict) continue;
    if (VERDICT_ORDER.indexOf(verdict) < VERDICT_ORDER.indexOf("needs_review")) verdict = "needs_review";
    reasons.push(conflict);
  }
  if (verdict === "block" || verdict === "needs_review") {
    reasons.push(
      "Re-implementing from a behavior spec lowers but does not remove this risk if the code was read closely.",
    );
  }

  return {
    source,
    target,
    file_overrides: overrides.slice(0, 200),
    verdict,
    conditions,
    reasons,
    disclaimer:
      "Automated heuristic, not legal advice. Review with counsel for commercial or high-stakes use.",
  };
}
