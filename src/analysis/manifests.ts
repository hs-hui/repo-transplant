import path from "node:path";
import { parseJsonc } from "../util/fsx.js";
import { normalizeNewlines } from "../util/text.js";

export type Ecosystem = "npm" | "pypi" | "go" | "cargo" | "rubygems" | "packagist" | "maven" | "nuget";

export interface Dependency {
  ecosystem: Ecosystem;
  name: string;
  version: string;
  dev: boolean;
  manifest: string;
}

const MANIFEST_NAME =
  /^(package\.json|pyproject\.toml|Pipfile|requirements([._-].*)?\.txt|go\.mod|Cargo\.toml|Gemfile|composer\.json|pom\.xml|build\.gradle(\.kts)?|.*\.csproj)$/;

export const isManifest = (rel: string): boolean => MANIFEST_NAME.test(path.posix.basename(rel));

function tomlSection(text: string, header: string): string {
  const start = text.search(new RegExp(`^\\[${header.replace(/[.]/g, "\\.")}\\]\\s*$`, "m"));
  if (start === -1) return "";
  const body = text.slice(start).split("\n").slice(1);
  const end = body.findIndex((line) => /^\[/.test(line));
  return (end === -1 ? body : body.slice(0, end)).join("\n");
}

function tomlKeyVersions(section: string): [string, string][] {
  const pairs: [string, string][] = [];
  for (const line of section.split("\n")) {
    const match = line.match(/^\s*"?([A-Za-z0-9_.-]+)"?\s*=\s*(.+)$/);
    if (!match) continue;
    const version =
      match[2]!.match(/version\s*=\s*"([^"]+)"/)?.[1] ?? match[2]!.match(/^"([^"]+)"/)?.[1] ?? "*";
    pairs.push([match[1]!, version]);
  }
  return pairs;
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
  const deps: Dependency[] = [];
  const pep621 =
    text.match(/^dependencies\s*=\s*\[([\s\S]*?)^\s*\]/m) ?? text.match(/^dependencies\s*=\s*\[(.*)\]/m);
  for (const entry of pep621?.[1]?.match(/["']([^"']+)["']/g) ?? []) {
    const parsed = pep508(entry.slice(1, -1));
    if (parsed) deps.push({ ecosystem: "pypi", name: parsed[0], version: parsed[1], dev: false, manifest });
  }
  for (const [name, version] of tomlKeyVersions(tomlSection(text, "tool.poetry.dependencies"))) {
    if (name !== "python") {
      deps.push({ ecosystem: "pypi", name: name.toLowerCase(), version, dev: false, manifest });
    }
  }
  for (const header of ["tool.poetry.dev-dependencies", "tool.poetry.group.dev.dependencies"]) {
    for (const [name, version] of tomlKeyVersions(tomlSection(text, header))) {
      deps.push({ ecosystem: "pypi", name: name.toLowerCase(), version, dev: true, manifest });
    }
  }
  return deps;
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
  const deps: Dependency[] = [];
  const sections: [string, boolean][] = [
    ["dependencies", false],
    ["build-dependencies", false],
    ["dev-dependencies", true],
  ];
  for (const [header, dev] of sections) {
    for (const [name, version] of tomlKeyVersions(tomlSection(text, header))) {
      deps.push({ ecosystem: "cargo", name, version, dev, manifest });
    }
    // Long form: a [dependencies.serde] table with its own keys.
    for (const match of text.matchAll(new RegExp(`^\\[${header}\\.([A-Za-z0-9_-]+)\\]\\s*$`, "gm"))) {
      const body = tomlSection(text, `${header}.${match[1]}`);
      const version = body.match(/^\s*version\s*=\s*"([^"]+)"/m)?.[1] ?? "*";
      deps.push({ ecosystem: "cargo", name: match[1]!, version, dev, manifest });
    }
  }
  return deps;
}

function parseGemfile(text: string, manifest: string): Dependency[] {
  const deps: Dependency[] = [];
  for (const match of text.matchAll(/^\s*gem\s+['"]([^'"]+)['"](?:\s*,\s*['"]([^'"]+)['"])?/gm)) {
    deps.push({ ecosystem: "rubygems", name: match[1]!, version: match[2] ?? "*", dev: false, manifest });
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

function parseGradle(text: string, manifest: string): Dependency[] {
  const deps: Dependency[] = [];
  const pattern =
    /(implementation|api|compileOnly|runtimeOnly|testImplementation)\s*\(?\s*['"]([^:'"]+):([^:'"]+)(?::([^'"]+))?['"]/g;
  for (const match of text.matchAll(pattern)) {
    deps.push({
      ecosystem: "maven",
      name: `${match[2]}:${match[3]}`,
      version: match[4] ?? "*",
      dev: match[1] === "testImplementation",
      manifest,
    });
  }
  return deps;
}

function parseCsproj(text: string, manifest: string): Dependency[] {
  const deps: Dependency[] = [];
  for (const match of text.matchAll(/<PackageReference\s+Include="([^"]+)"(?:\s+Version="([^"]+)")?/g)) {
    deps.push({ ecosystem: "nuget", name: match[1]!, version: match[2] ?? "*", dev: false, manifest });
  }
  return deps;
}

export function parseManifest(rel: string, rawText: string): Dependency[] {
  const text = normalizeNewlines(rawText);
  const base = path.posix.basename(rel);
  if (base === "package.json") return parsePackageJson(text, rel);
  if (base === "pyproject.toml") return parsePyproject(text, rel);
  if (base === "Pipfile") {
    return tomlKeyVersions(tomlSection(text, "packages")).map(([name, version]) => ({
      ecosystem: "pypi" as const,
      name: name.toLowerCase(),
      version,
      dev: false,
      manifest: rel,
    }));
  }
  if (/^requirements([._-].*)?\.txt$/.test(base)) return parseRequirements(text, rel);
  if (base === "go.mod") return parseGoMod(text, rel);
  if (base === "Cargo.toml") return parseCargo(text, rel);
  if (base === "Gemfile") return parseGemfile(text, rel);
  if (base === "composer.json") return parseComposer(text, rel);
  if (base === "pom.xml") return parsePom(text, rel);
  if (/^build\.gradle(\.kts)?$/.test(base)) return parseGradle(text, rel);
  if (base.endsWith(".csproj")) return parseCsproj(text, rel);
  return [];
}
