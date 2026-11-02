import path from "node:path";
import { parse as parseTomlText } from "smol-toml";
import { parseJsonc } from "../util/fsx.js";
import { normalizeNewlines } from "../util/text.js";

export type Ecosystem = "npm" | "pypi" | "go" | "cargo" | "rubygems" | "packagist" | "maven" | "nuget";

export interface Dependency {
  ecosystem: Ecosystem;
  name: string;
  version: string;
  dev: boolean;
  manifest: string;
  /** Options beside the version, when there are any (a git or path source, say). */
  source?: string;
}

const MANIFEST_NAME =
  /^(package\.json|pyproject\.toml|Pipfile|go\.mod|Cargo\.toml|Gemfile|composer\.json|pom\.xml|build\.gradle(\.kts)?|.*\.(cs|fs|vb)proj)$/;

/** pip takes any name with -r, and projects keep these in requirements/ and as constraints or .in files. */
export const isRequirementsFile = (rel: string): boolean =>
  /(^|\/)requirements\/[^/]+\.(txt|in)$|(^|\/)(requirements|constraints)([._-][^/]*)?\.(txt|in)$/.test(rel);

export const isManifest = (rel: string): boolean =>
  MANIFEST_NAME.test(path.posix.basename(rel)) || isRequirementsFile(rel);

type TomlTable = Record<string, unknown>;

/** Parses a TOML manifest, or returns null. Tools accept many spellings of a key, so lines cannot be trusted. */
export function parseToml(text: string): TomlTable | null {
  try {
    return parseTomlText(normalizeNewlines(text));
  } catch {
    return null;
  }
}

const asTable = (value: unknown): TomlTable =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as TomlTable) : {};

/** Name, version and options of each entry in a dependency table. */
function tomlDependencies(section: unknown): [string, string, string | undefined][] {
  return Object.entries(asTable(section)).map(([name, value]) => {
    if (typeof value === "string") return [name, value, undefined];
    // Poetry lists several constraints for one package as an array of tables.
    if (Array.isArray(value)) return [name, "*", JSON.stringify(value)];
    const { version, ...options } = asTable(value);
    const keys = Object.keys(options).sort();
    const source = keys.map((key) => `${key} = ${JSON.stringify(options[key])}`).join(", ");
    return [name, typeof version === "string" ? version : "*", source || undefined];
  });
}

function pep508(entry: string): [string, string] | null {
  const match = entry.trim().match(/^([A-Za-z0-9][A-Za-z0-9._-]*)(\[[^\]]*\])?\s*(.*)$/);
  if (!match) return null;
  return [match[1]!.toLowerCase().replace(/_/g, "-"), match[3]!.split(";")[0]!.trim() || "*"];
}

function parsePackageJson(text: string, manifest: string): Dependency[] {
  const pkg = parseJsonc<Record<string, Record<string, string> | undefined>>(text);
  if (!pkg) return [];
  const deps: Dependency[] = [];
  const sections: [string, boolean][] = [
    ["dependencies", false],
    ["peerDependencies", false],
    ["optionalDependencies", false],
    ["devDependencies", true],
  ];
  for (const [section, dev] of sections) {
    for (const [name, version] of Object.entries(pkg[section] ?? {})) {
      if (typeof version === "string") deps.push({ ecosystem: "npm", name, version, dev, manifest });
    }
  }
  return deps;
}

function parsePyproject(text: string, manifest: string): Dependency[] {
  const doc = parseToml(text);
  if (!doc) return [];
  const deps: Dependency[] = [];
  const addList = (entries: unknown, dev: boolean): void => {
    for (const entry of Array.isArray(entries) ? entries : []) {
      const parsed = typeof entry === "string" ? pep508(entry) : null;
      if (parsed) deps.push({ ecosystem: "pypi", name: parsed[0], version: parsed[1], dev, manifest });
    }
  };
  const addTable = (section: unknown, dev: boolean): void => {
    for (const [name, version, source] of tomlDependencies(section)) {
      if (name === "python") continue;
      deps.push({ ecosystem: "pypi", name: name.toLowerCase(), version, dev, manifest, source });
    }
  };
  const project = asTable(doc.project);
  const poetry = asTable(asTable(doc.tool).poetry);
  addList(project.dependencies, false);
  for (const list of Object.values(asTable(project["optional-dependencies"]))) addList(list, false);
  for (const list of Object.values(asTable(doc["dependency-groups"]))) addList(list, true);
  addTable(poetry.dependencies, false);
  addTable(poetry["dev-dependencies"], true);
  for (const group of Object.values(asTable(poetry.group))) addTable(asTable(group).dependencies, true);
  return deps;
}

function parsePipfile(text: string, manifest: string): Dependency[] {
  const doc = parseToml(text);
  if (!doc) return [];
  const sections: [unknown, boolean][] = [
    [doc.packages, false],
    [doc["dev-packages"], true],
  ];
  return sections.flatMap(([section, dev]) =>
    tomlDependencies(section).map(([name, version, source]) => ({
      ecosystem: "pypi" as const,
      name: name.toLowerCase(),
      version,
      dev,
      manifest,
      source,
    })),
  );
}

function parseRequirements(text: string, manifest: string): Dependency[] {
  const dev = /dev|test/i.test(path.posix.basename(manifest));
  const deps: Dependency[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.split("#")[0]!.trim();
    if (!line || line.startsWith("-")) continue;
    const parsed = pep508(line);
    if (parsed) deps.push({ ecosystem: "pypi", name: parsed[0], version: parsed[1], dev, manifest });
  }
  return deps;
}

function parseGoMod(text: string, manifest: string): Dependency[] {
  const deps: Dependency[] = [];
  const add = (line: string): void => {
    const match = line.trim().match(/^([^\s/]+\.[^\s]+)\s+(v[^\s]+)(\s+\/\/\s*indirect)?/);
    if (match && !match[3]) {
      deps.push({ ecosystem: "go", name: match[1]!, version: match[2]!, dev: false, manifest });
    }
  };
  for (const block of text.matchAll(/^require\s*\(([\s\S]*?)^\)/gm)) block[1]!.split("\n").forEach(add);
  for (const line of text.matchAll(/^require\s+([^(\n].*)$/gm)) add(line[1]!);
  return deps;
}

function parseCargo(text: string, manifest: string): Dependency[] {
  const doc = parseToml(text);
  if (!doc) return [];
  const deps: Dependency[] = [];
  const sections: [string, boolean][] = [
    ["dependencies", false],
    ["build-dependencies", false],
    ["dev-dependencies", true],
  ];
  // A dependency can also live under [workspace.dependencies] or a [target.<cfg>.dependencies] table.
  const scopes = [doc, asTable(doc.workspace), ...Object.values(asTable(doc.target)).map(asTable)];
  for (const scope of scopes) {
    for (const [header, dev] of sections) {
      for (const [name, version, source] of tomlDependencies(scope[header])) {
        deps.push({ ecosystem: "cargo", name, version, dev, manifest, source });
      }
    }
  }
  return deps;
}

function parseGemfile(text: string, manifest: string): Dependency[] {
  const deps: Dependency[] = [];
  for (const match of text.matchAll(/^\s*gem\s+['"]([^'"]+)['"]([^\n]*)$/gm)) {
    const options = match[2]!
      .replace(/\s+#.*$/, "")
      .trim()
      .replace(/^,\s*/, "");
    const version = options.match(/^['"]([^'"]+)['"]/)?.[1] ?? "*";
    deps.push({
      ecosystem: "rubygems",
      name: match[1]!,
      version,
      dev: false,
      manifest,
      source: options || undefined,
    });
  }
  return deps;
}

function parseComposer(text: string, manifest: string): Dependency[] {
  const pkg = parseJsonc<{ require?: Record<string, string>; "require-dev"?: Record<string, string> }>(text);
  if (!pkg) return [];
  const deps: Dependency[] = [];
  const add = (section: Record<string, string> | undefined, dev: boolean): void => {
    for (const [name, version] of Object.entries(section ?? {})) {
      if (name !== "php" && !name.startsWith("ext-")) {
        deps.push({ ecosystem: "packagist", name, version, dev, manifest });
      }
    }
  };
  add(pkg.require, false);
  add(pkg["require-dev"], true);
  return deps;
}

function parsePom(text: string, manifest: string): Dependency[] {
  const deps: Dependency[] = [];
  for (const block of text.matchAll(/<dependency>([\s\S]*?)<\/dependency>/g)) {
    const group = block[1]!.match(/<groupId>([^<]+)/)?.[1];
    const artifact = block[1]!.match(/<artifactId>([^<]+)/)?.[1];
    if (!group || !artifact) continue;
    deps.push({
      ecosystem: "maven",
      name: `${group}:${artifact}`,
      version: block[1]!.match(/<version>([^<]+)/)?.[1] ?? "*",
      dev: /<scope>test/.test(block[1]!),
      manifest,
    });
  }
  return deps;
}

const GRADLE_DEPENDENCY =
  /^\s*(?!println\b|print\b|id\b|task\b|group\b|version\b|description\b|apply\b)(\w+)\s*\(?\s*(?:(?:enforcedPlatform|platform|testFixtures)\(\s*)?['"]([^:'"\s]+):([^:'"\s]+)(?::([^'"]+))?['"]/gm;
const GRADLE_NAMED =
  /^\s*(\w+)\s*\(?\s*group\s*[:=]\s*['"]([^'"]+)['"]\s*,\s*name\s*[:=]\s*['"]([^'"]+)['"](?:\s*,\s*version\s*[:=]\s*['"]([^'"]+)['"])?/gm;

function parseGradle(text: string, manifest: string): Dependency[] {
  const deps: Dependency[] = [];
  for (const pattern of [GRADLE_DEPENDENCY, GRADLE_NAMED]) {
    for (const match of text.matchAll(pattern)) {
      deps.push({
        ecosystem: "maven",
        name: `${match[2]}:${match[3]}`,
        version: match[4] ?? "*",
        dev: /^test/i.test(match[1]!),
        manifest,
      });
    }
  }
  return deps;
}

/** An attribute in either quote style, wherever it sits in the tag. */
const xmlAttribute = (tag: string, name: string): string | undefined => {
  const match = tag.match(new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, "i"));
  return match?.[1] ?? match?.[2];
};

function parseCsproj(text: string, manifest: string): Dependency[] {
  const deps: Dependency[] = [];
  for (const match of text.matchAll(/<PackageReference\b([^>]*?)(?:\/>|>([\s\S]*?)<\/PackageReference>)/gi)) {
    const tag = match[1]!;
    const name = xmlAttribute(tag, "Include") ?? xmlAttribute(tag, "Update");
    if (!name) continue;
    const version =
      xmlAttribute(tag, "Version") ??
      xmlAttribute(tag, "VersionOverride") ??
      match[2]?.match(/<Version>([^<]+)/i)?.[1];
    deps.push({ ecosystem: "nuget", name, version: version ?? "*", dev: false, manifest });
  }
  return deps;
}

export function parseManifest(rel: string, rawText: string): Dependency[] {
  const text = normalizeNewlines(rawText);
  const base = path.posix.basename(rel);
  if (base === "package.json") return parsePackageJson(text, rel);
  if (base === "pyproject.toml") return parsePyproject(text, rel);
  if (base === "Pipfile") return parsePipfile(text, rel);
  if (isRequirementsFile(rel)) return parseRequirements(text, rel);
  if (base === "go.mod") return parseGoMod(text, rel);
  if (base === "Cargo.toml") return parseCargo(text, rel);
  if (base === "Gemfile") return parseGemfile(text, rel);
  if (base === "composer.json") return parseComposer(text, rel);
  if (base === "pom.xml") return parsePom(text, rel);
  if (/^build\.gradle(\.kts)?$/.test(base)) return parseGradle(text, rel);
  if (/\.(cs|fs|vb)proj$/.test(base)) return parseCsproj(text, rel);
  return [];
}
