import { readdir } from "node:fs/promises";
import path from "node:path";
import { type FileClass, walkRepo } from "../repo/walk.js";
import { assertSafeRelative, parseJsonc, pathExists, readHead, readText } from "../util/fsx.js";

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
  "Unicode-3.0": "permissive",
  "Unicode-DFS-2016": "permissive",
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
const FINGERPRINTS: { id: string; all: string[]; none?: string[] }[] = [
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
  { id: "Unicode-3.0", all: ["unicode license v3"] },
  { id: "Unicode-3.0", all: ["unicode, inc. license agreement"] },
  { id: "Zlib", all: ["altered source versions must be plainly marked as such"] },
  {
    id: "BSD-3-Clause",
    all: ["redistribution and use in source and binary forms", "neither the name"],
  },
  {
    id: "BSD-2-Clause",
    all: ["redistribution and use in source and binary forms"],
  },
  // These two are told apart by name only. Reading a shortened MIT as MIT-0 would drop its conditions.
  { id: "MIT-0", all: ["mit no attribution"] },
  { id: "MIT", all: ["permission is hereby granted, free of charge", "the software is provided"] },
  {
    id: "0BSD",
    all: ["permission to use, copy, modify, and", "distribute this software for any purpose"],
    none: ["provided that the above copyright notice"],
  },
  { id: "ISC", all: ["permission to use, copy, modify, and", "distribute this software for any purpose"] },
];

/** A GNU title stands alone on its line, which tells a license from a sentence that cites one. */
const GNU_TITLE_LINE = /^\s*GNU (AFFERO |LESSER )?GENERAL PUBLIC LICENSE\s*\n\s*Version (\d(?:\.\d)?)/gm;

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

/** The old Cargo spelling of a choice, as in MIT/Apache-2.0. */
const withoutSlashes = (expression: string): string => expression.replace(/\s*\/\s*/g, " OR ");

/** Parses an SPDX expression by precedence: AND binds tighter than OR, and parentheses override both. */
function parseExpression(expression: string): Resolved {
  const tokens = withoutSlashes(expression).match(/[()]|[^\s()]+/g) ?? [];
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
  return (withoutSlashes(expression).match(/[^\s()]+/g) ?? [])
    .filter((token) => !/^(AND|OR|WITH)$/i.test(token))
    .map(normalizeSpdx);
}

/** Every license a text contains. One file can hold several, such as a project's and a bundled library's. */
export function identifyLicenseTexts(text: string): string[] {
  // Notices often sit in a comment block.
  const plain = text.replace(/^[ \t]*(?:#|\/\/|\*|;|--)[ \t]?/gm, "");
  const normalized = plain.toLowerCase().replace(/[“”]/g, '"').replace(/[‘’]/g, "'").replace(/\s+/g, " ");
  const head = normalized.slice(0, 600);
  const ids = new Set<string>();
  const gnu = GNU_TITLES.find(({ title, version }) => head.includes(title) && head.includes(version));
  if (gnu) ids.add(gnu.id);
  for (const match of plain.matchAll(GNU_TITLE_LINE)) {
    const title = `gnu ${(match[1] ?? "").toLowerCase()}general public license`;
    const found = GNU_TITLES.find(
      (item) =>
        item.title === title &&
        (!item.version ||
          item.version.endsWith(match[2]!.split(".")[0]!) ||
          item.version.endsWith(match[2]!)),
    );
    if (found) ids.add(found.id);
  }
  for (const { id, all, none } of FINGERPRINTS) {
    const present = all.every((phrase) => normalized.includes(phrase));
    if (present && !none?.some((phrase) => normalized.includes(phrase))) ids.add(id);
  }
  // These texts contain the phrases of their weaker or stricter neighbor.
  if (ids.has("BSD-3-Clause")) ids.delete("BSD-2-Clause");
  if (ids.has("MIT-0")) ids.delete("MIT");
  if (ids.has("0BSD")) ids.delete("ISC");
  return [...ids];
}

/** The strictest license in a text, or null when none is recognized. */
export function identifyLicenseText(text: string): string | null {
  const rank = (id: string): number => RESTRICTIVENESS.indexOf(classify(id));
  return identifyLicenseTexts(text).sort((a, b) => rank(b) - rank(a))[0] ?? null;
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

const LICENSE_FILE =
  /^(?!.*\.(?:[cm]?[jt]sx?|py|go|rs|rb|java|kt|php|c|h|css|html?|json|ya?ml|toml)$)(?:(?:LICEN[CS]E|COPYING|UNLICENSE)(?:[._-][A-Za-z0-9._-]+)?|[A-Za-z0-9.-]+[-_](?:LICEN[CS]E|COPYING)(?:\.(?:md|txt|rst))?)$/i;

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
    // REUSE projects keep every license in LICENSES/, named by its identifier.
    const reuse = entries.some((entry) => entry.isDirectory() && entry.name === "LICENSES")
      ? await readdir(path.join(absolute, "LICENSES"), { withFileTypes: true })
      : [];
    const named = [
      ...entries.map((entry) => ({ entry, rel: entry.name })),
      ...reuse.map((entry) => ({ entry, rel: `LICENSES/${entry.name}` })),
    ];
    for (const { entry, rel: inside } of named) {
      if (!entry.isFile()) continue;
      const rel = relDir ? `${relDir}/${inside}` : inside;
      if (/^NOTICE(\.[a-z]+)?$/i.test(entry.name) && !info.notice_file) info.notice_file = rel;
      if (!LICENSE_FILE.test(entry.name) && !inside.startsWith("LICENSES/")) continue;
      const text = await readText(path.join(root, rel), maxBytes);
      if (text === null) {
        // A license nobody can read is not the same as no license, so a manifest cannot speak over it.
        info.license_file ??= rel;
        info.evidence.push({ kind: "license_text", path: rel, value: "unreadable" });
        textIds.push("unrecognized");
        continue;
      }
      if (!text) continue;
      const ids = identifyLicenseTexts(text);
      info.license_file ??= rel;
      if (info.copyright.length === 0) {
        info.copyright = [...text.matchAll(/^.{0,200}copyright\s+(\(c\)|\u00a9|\d{4}).{0,200}$/gim)]
          .map((match) => match[0].trim().slice(0, 200))
          .slice(0, 5);
      }
      if (/commons clause/i.test(text)) info.commons_clause = true;
      info.evidence.push({ kind: "license_text", path: rel, value: ids.join(", ") || "unrecognized" });
      textIds.push(...(ids.length > 0 ? ids : ["unrecognized"]));
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

  // A manifest speaks for its own folder, so the one that counts sits beside the license that won.
  const licenseDir = info.license_file ? path.posix.dirname(info.license_file) : ".";
  const stop = chain.indexOf(licenseDir === "." ? "" : licenseDir.replace(/\/?LICENSES$/, ""));
  const manifestDirs = stop === -1 ? chain : chain.slice(0, stop + 1);
  let declared: { path: string; value: string }[] = [];
  for (const relDir of manifestDirs) {
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
      // With no text to settle it, manifests that disagree mean the strictest one, for a person to check.
      if (info.spdx && info.spdx !== resolved.spdx) {
        info.conflict = `${entry.path} says ${entry.value}, but another manifest says ${info.spdx}.`;
      }
      if (!info.spdx || rank(resolved.spdx) > rank(info.spdx)) {
        info.spdx = resolved.spdx;
        info.class = resolved.class;
      }
      continue;
    }
    if (info.class === "unknown") {
      info.conflict = `${entry.path} says ${entry.value}, but the license file could not be identified.`;
      continue;
    }
    const leaves = expressionLeaves(entry.value);
    const stricter = known.filter((id) => !leaves.includes(id) && rank(id) > rank(resolved.spdx));
    const covered = known.length === 0 || known.some((id) => leaves.includes(id));
    if (covered && stricter.length === 0) {
      // A dual-licensed manifest explains which of its texts may be chosen. Between equals, the one
      // with a text in the repository is the one to use.
      const chosen = known.includes(resolved.spdx)
        ? resolved.spdx
        : (known.find((id) => leaves.includes(id) && rank(id) === rank(resolved.spdx)) ?? resolved.spdx);
      info.spdx = chosen;
      info.class = classify(chosen);
      if (known.length > 0 && !known.includes(chosen)) {
        info.conflict = `${entry.path} says ${entry.value}, but the repository has no license text for ${chosen}.`;
      }
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
/** Past the header a tag only counts in a comment, since source can mention one in a string. */
const SPDX_COMMENT = /^\s*(?:\/\/|#|\/\*+|\*|<!--|--|;|%)\s*SPDX-License-Identifier:\s*([^\r\n*]+)/m;

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

/** A test or stylesheet is as copyable as a source file, and a directory name decides nothing. */
const LICENSED_CLASSES = new Set<FileClass>(["source", "test", "style"]);
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
      .filter((file) => LICENSED_CLASSES.has(file.fileClass))
      .map((file) => file.rel);
  for (const rel of selected) {
    assertSafeRelative(rel);
    const file = path.join(sourceRoot, rel);
    const text = (await readText(file, options.maxFileBytes)) ?? (await readHead(file, 2000));
    const header = text?.slice(0, 2000).match(SPDX_HEADER) ?? text?.match(SPDX_COMMENT);
    if (header) {
      const resolved = resolveExpression(header[1]!.trim());
      if (resolved.spdx !== source.spdx) {
        overrides.push({ path: rel, spdx: resolved.spdx, class: resolved.class, source: "spdx_header" });
      }
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
