import { readFile } from "node:fs/promises";
import path from "node:path";
import { LANGUAGE_BY_EXT, type RepoFile, walkRepo } from "../repo/walk.js";
import { parseJsonc, pathExists, readText } from "../util/fsx.js";
import { type Category, technologiesFor } from "./catalog.js";
import { type Dependency, isManifest, parseManifest } from "./manifests.js";

export interface SuggestedCommand {
  name: string;
  command: string;
  kind: "install" | "typecheck" | "lint" | "test" | "build";
}

export interface SuggestedService {
  name: string;
  image: string;
  env: Record<string, string>;
  ready_command: string;
}

export interface Conventions {
  indent: "tabs" | "2 spaces" | "4 spaces" | "unknown";
  quotes: "single" | "double" | "unknown";
  semicolons: boolean | null;
  fileNaming: Record<string, number>;
  exportStyle: "default" | "named" | "mixed" | "unknown";
  testLayout: "colocated" | "separate_dir" | "none";
  pathAliases: Record<string, string[]>;
  architecture: string[];
  formatters: string[];
  linters: string[];
}

export interface DesignSystem {
  cssVariables: string[];
  tailwindConfig: string | null;
  componentConfig: string | null;
  uiComponents: string[];
  themeFiles: string[];
}

export interface RepoProfile {
  root: string;
  fileCount: number;
  languages: { language: string; bytes: number; share: number }[];
  packageManager: string | null;
  monorepo: { tool: string | null; packages: string[] };
  stack: Partial<Record<Category, string[]>>;
  dependencies: Dependency[];
  license_files: string[];
  conventions: Conventions;
  design_system: DesignSystem;
  has_backend: boolean;
  has_frontend: boolean;
  suggested_commands: SuggestedCommand[];
  /** Images that have this project's toolchain, for checks this machine cannot run itself. */
  suggested_docker_image: string | null;
  /** Databases the project uses, ready to paste into verification.services. */
  suggested_services: SuggestedService[];
  infrastructure: string[];
  top_level: string[];
  scripts: Record<string, string>;
}

function detectPackageManager(
  names: Set<string>,
  rootPackage: Record<string, unknown> | null,
): string | null {
  const declared = rootPackage?.packageManager;
  if (typeof declared === "string") return declared.split("@")[0]!;
  if (names.has("pnpm-lock.yaml")) return "pnpm";
  if (names.has("bun.lockb") || names.has("bun.lock")) return "bun";
  if (names.has("yarn.lock")) return "yarn";
  if (names.has("package-lock.json")) return "npm";
  if (names.has("package.json")) return "npm";
  if (names.has("uv.lock")) return "uv";
  if (names.has("poetry.lock")) return "poetry";
  if (names.has("requirements.txt") || names.has("pyproject.toml")) return "pip";
  if (names.has("go.mod")) return "go";
  if (names.has("Cargo.toml")) return "cargo";
  if (names.has("Gemfile")) return "bundler";
  if (names.has("composer.json")) return "composer";
  if (names.has("pom.xml")) return "maven";
  if (names.has("build.gradle") || names.has("build.gradle.kts")) return "gradle";
  return null;
}

function languageShares(files: RepoFile[]): RepoProfile["languages"] {
  const bytes = new Map<string, number>();
  for (const file of files) {
    if (file.fileClass === "generated" || file.fileClass === "lock") continue;
    const language = LANGUAGE_BY_EXT[file.ext];
    if (language) bytes.set(language, (bytes.get(language) ?? 0) + file.size);
  }
  const total = [...bytes.values()].reduce((sum, value) => sum + value, 0) || 1;
  return [...bytes.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([language, size]) => ({ language, bytes: size, share: Math.round((size / total) * 1000) / 10 }));
}

function fileNaming(files: RepoFile[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const file of files) {
    if (file.fileClass !== "source") continue;
    const stem = path.posix.basename(file.rel).split(".")[0]!;
    if (stem === "index" || stem.length < 3) continue;
    const style = /^[A-Z][A-Za-z0-9]*$/.test(stem)
      ? "PascalCase"
      : /^[a-z][a-z0-9]*(-[a-z0-9]+)+$/.test(stem)
        ? "kebab-case"
        : /^[a-z][a-z0-9]*(_[a-z0-9]+)+$/.test(stem)
          ? "snake_case"
          : /^[a-z]+[A-Z]/.test(stem)
            ? "camelCase"
            : "lowercase";
    counts[style] = (counts[style] ?? 0) + 1;
  }
  return counts;
}

function detectArchitecture(files: RepoFile[]): string[] {
  const has = (pattern: RegExp): boolean => files.some((file) => pattern.test(file.rel));
  const styles: string[] = [];
  if (has(/(^|\/)(features|modules|domains)\/[^/]+\//)) styles.push("feature_folders");
  if (has(/(^|\/)controllers?\//) && has(/(^|\/)services?\//)) styles.push("layered_controller_service");
  if (has(/(^|\/)repositor(y|ies)\//)) styles.push("repository_pattern");
  if (has(/(^|\/)routes?\//)) styles.push("route_files");
  if (has(/(^|\/)app\/(.*\/)?(page|layout)\.[jt]sx?$/)) styles.push("next_app_router");
  if (has(/(^|\/)pages\/api\//)) styles.push("next_pages_api");
  if (has(/(^|\/)hooks?\//)) styles.push("hooks_dir");
  if (has(/(^|\/)components\/ui\//)) styles.push("ui_primitives_dir");
  if (has(/(^|\/)cmd\/[^/]+\/main\.go$/)) styles.push("go_cmd_layout");
  if (has(/(^|\/)internal\//)) styles.push("go_internal_packages");
  if (has(/(^|\/)app\/(models|controllers|views)\//)) styles.push("rails_or_laravel_mvc");
  if (has(/(^|\/)(manage\.py)$/)) styles.push("django_project");
  return styles;
}

interface SampleStats {
  tabs: number;
  two: number;
  four: number;
  single: number;
  double: number;
  semi: number;
  noSemi: number;
  defaultExports: number;
  namedExports: number;
}

function sampleStyle(text: string, stats: SampleStats): void {
  for (const line of text.split("\n").slice(0, 400)) {
    if (line.startsWith("\t")) stats.tabs++;
    else if (/^ {2}\S/.test(line)) stats.two++;
    else if (/^ {4}\S/.test(line)) stats.four++;
    const code = line.trim();
    if (!code || code.startsWith("//") || code.startsWith("*")) continue;
    stats.single += (code.match(/'[^'\n]*'/g) ?? []).length;
    stats.double += (code.match(/"[^"\n]*"/g) ?? []).length;
    if (/[)\]\w'"`]\s*;$/.test(code)) stats.semi++;
    else if (/^(const|let|return|import)\b.*[)\]\w'"`]$/.test(code)) stats.noSemi++;
    if (/^export default\b/.test(code)) stats.defaultExports++;
    else if (/^export (const|function|class|type|interface)\b/.test(code)) stats.namedExports++;
  }
}

async function readConventions(root: string, files: RepoFile[]): Promise<Conventions> {
  const stats: SampleStats = {
    tabs: 0,
    two: 0,
    four: 0,
    single: 0,
    double: 0,
    semi: 0,
    noSemi: 0,
    defaultExports: 0,
    namedExports: 0,
  };
  const code = files.filter((file) => file.fileClass === "source" && file.size < 200_000);
  const stride = Math.max(1, Math.floor(code.length / 150));
  for (let i = 0; i < code.length; i += stride) {
    const text = await readText(path.join(root, code[i]!.rel), 200_000);
    if (text) sampleStyle(text, stats);
  }

  const indent =
    stats.tabs + stats.two + stats.four === 0
      ? "unknown"
      : stats.tabs > stats.two && stats.tabs > stats.four
        ? "tabs"
        : stats.two >= stats.four
          ? "2 spaces"
          : "4 spaces";

  const pathAliases: Record<string, string[]> = {};
  for (const name of ["tsconfig.json", "jsconfig.json", "tsconfig.app.json"]) {
    const text = await readText(path.join(root, name), 500_000);
    const parsed = text ? parseJsonc<{ compilerOptions?: { paths?: Record<string, string[]> } }>(text) : null;
    Object.assign(pathAliases, parsed?.compilerOptions?.paths ?? {});
  }

  const names = new Set(files.map((file) => path.posix.basename(file.rel)));
  const anyOf = (...candidates: string[]): boolean => candidates.some((name) => names.has(name));
  const formatters = [
    anyOf(
      ".prettierrc",
      ".prettierrc.json",
      ".prettierrc.js",
      ".prettierrc.yaml",
      "prettier.config.js",
      "prettier.config.mjs",
    ) && "prettier",
    anyOf("biome.json", "biome.jsonc") && "biome",
    anyOf(".editorconfig") && "editorconfig",
    anyOf("rustfmt.toml") && "rustfmt",
  ].filter(Boolean) as string[];
  const linters = [
    anyOf(
      ".eslintrc",
      ".eslintrc.js",
      ".eslintrc.cjs",
      ".eslintrc.json",
      "eslint.config.js",
      "eslint.config.mjs",
      "eslint.config.ts",
    ) && "eslint",
    anyOf("ruff.toml", ".ruff.toml") && "ruff",
    anyOf(".golangci.yml", ".golangci.yaml") && "golangci-lint",
    anyOf(".rubocop.yml") && "rubocop",
  ].filter(Boolean) as string[];

  const tests = files.filter((file) => file.fileClass === "test");
  const testLayout =
    tests.length === 0
      ? "none"
      : tests.filter((file) => /(^|\/)(tests?|__tests__|spec)\//.test(file.rel)).length > tests.length / 2
        ? "separate_dir"
        : "colocated";

  return {
    indent,
    quotes: stats.single + stats.double === 0 ? "unknown" : stats.single > stats.double ? "single" : "double",
    semicolons: stats.semi + stats.noSemi === 0 ? null : stats.semi > stats.noSemi,
    fileNaming: fileNaming(files),
    exportStyle:
      stats.defaultExports + stats.namedExports === 0
        ? "unknown"
        : stats.defaultExports > stats.namedExports * 2
          ? "default"
          : stats.namedExports > stats.defaultExports * 2
            ? "named"
            : "mixed",
    testLayout,
    pathAliases,
    architecture: detectArchitecture(files),
    formatters,
    linters,
  };
}

async function readDesignSystem(root: string, files: RepoFile[]): Promise<DesignSystem> {
  const cssVariables = new Set<string>();
  const styleFiles = files
    .filter(
      (file) => file.fileClass === "style" && /(global|theme|token|variable|index|app|main)/i.test(file.rel),
    )
    .slice(0, 12);
  for (const file of styleFiles) {
    const text = await readText(path.join(root, file.rel), 500_000);
    for (const match of text?.matchAll(/(--[a-zA-Z0-9-]+)\s*:/g) ?? []) cssVariables.add(match[1]!);
  }
  return {
    cssVariables: [...cssVariables].slice(0, 80),
    tailwindConfig: files.find((file) => /(^|\/)tailwind\.config\.[a-z]+$/.test(file.rel))?.rel ?? null,
    componentConfig: files.find((file) => /(^|\/)components\.json$/.test(file.rel))?.rel ?? null,
    uiComponents: files
      .filter((file) => /(^|\/)components\/ui\/[^/]+\.(tsx|jsx|vue|svelte)$/.test(file.rel))
      .map((file) => file.rel)
      .slice(0, 80),
    themeFiles: files
      .filter((file) => /(theme|tokens?|design-system)/i.test(path.posix.basename(file.rel)))
      .filter(
        (file) => file.fileClass === "source" || file.fileClass === "style" || file.fileClass === "config",
      )
      .map((file) => file.rel)
      .slice(0, 20),
  };
}

function detectInfrastructure(files: RepoFile[]): string[] {
  const has = (pattern: RegExp): boolean => files.some((file) => pattern.test(file.rel));
  const found: [boolean, string][] = [
    [has(/(^|\/)Dockerfile/), "docker"],
    [has(/(^|\/)(docker-)?compose\.ya?ml$/), "docker-compose"],
    [has(/^\.github\/workflows\//), "github-actions"],
    [has(/(^|\/)vercel\.json$/), "vercel"],
    [has(/(^|\/)fly\.toml$/), "fly.io"],
    [has(/(^|\/)netlify\.toml$/), "netlify"],
    [has(/\.tf$/), "terraform"],
    [has(/(^|\/)k8s\//), "kubernetes"],
    [has(/(^|\/)prisma\/schema\.prisma$/), "prisma-schema"],
    [has(/(^|\/)alembic\.ini$/), "alembic"],
    [has(/(^|\/)wrangler\.(toml|jsonc?)$/), "cloudflare-workers"],
  ];
  return found.filter(([present]) => present).map(([, name]) => name);
}

const KNOWN_SERVICES: { image: RegExp; packages: RegExp; service: SuggestedService }[] = [
  {
    image: /^(postgres|postgis\/postgis|pgvector\/pgvector)\b/,
    packages: /^(pg|postgres|psycopg2?(-binary)?|asyncpg|github\.com\/lib\/pq|github\.com\/jackc\/pgx.*)$/,
    service: {
      name: "db",
      image: "postgres:16-alpine",
      env: { POSTGRES_PASSWORD: "local-only" },
      ready_command: "pg_isready -U postgres",
    },
  },
  {
    image: /^(mysql|mariadb)\b/,
    packages: /^(mysql2?|mysqlclient|pymysql|github\.com\/go-sql-driver\/mysql)$/,
    service: {
      name: "db",
      image: "mysql:8",
      env: { MYSQL_ROOT_PASSWORD: "local-only" },
      ready_command: "mysqladmin ping -h 127.0.0.1 -plocal-only",
    },
  },
  {
    image: /^(redis|valkey\/valkey)\b/,
    packages: /^(redis|ioredis|github\.com\/redis\/go-redis.*)$/,
    service: { name: "redis", image: "redis:7-alpine", env: {}, ready_command: "redis-cli ping" },
  },
  {
    image: /^mongo\b/,
    packages: /^(mongodb|mongoose|pymongo|motor)$/,
    service: {
      name: "mongo",
      image: "mongo:7",
      env: {},
      ready_command: "mongosh --quiet --eval 'db.runCommand({ping:1})'",
    },
  },
];

/** Reads which databases a project runs, from its compose files and its drivers. */
async function suggestServices(
  root: string,
  files: RepoFile[],
  dependencies: Dependency[],
): Promise<SuggestedService[]> {
  const images: string[] = [];
  for (const file of files
    .filter((item) => /(^|\/)(docker-)?compose[^/]*\.ya?ml$/.test(item.rel))
    .slice(0, 5)) {
    const text = (await readText(path.join(root, file.rel), 256 * 1024)) ?? "";
    for (const match of text.matchAll(/^\s*image:\s*["']?([^\s"'#]+)/gm)) images.push(match[1]!);
  }
  return KNOWN_SERVICES.filter(
    ({ image, packages }) =>
      images.some((item) => image.test(item)) || dependencies.some((dep) => packages.test(dep.name)),
  )
    .map((item) => item.service)
    .filter((service, index, all) => all.findIndex((other) => other.name === service.name) === index);
}

/** Picks an official image for the project's toolchain, at the version it asks for when that is clear. */
async function suggestDockerImage(root: string, names: Set<string>): Promise<string | null> {
  const read = async (name: string): Promise<string> =>
    names.has(name) ? ((await readText(path.join(root, name), 256 * 1024)) ?? "") : "";
  if (names.has("package.json")) {
    const version = (await read(".nvmrc")).match(/\d+/)?.[0];
    return `node:${version ?? "24"}`;
  }
  if (names.has("go.mod")) {
    const version = (await read("go.mod")).match(/^go (\d+\.\d+)/m)?.[1];
    return `golang:${version ?? "1"}`;
  }
  if (names.has("pyproject.toml") || names.has("requirements.txt") || names.has("manage.py")) {
    const version = (await read("pyproject.toml")).match(/requires-python\s*=\s*["'][^0-9]*(\d+\.\d+)/)?.[1];
    if (names.has("uv.lock")) return `ghcr.io/astral-sh/uv:python${version ?? "3.12"}-bookworm-slim`;
    return `python:${version ?? "3.12"}-slim`;
  }
  if (names.has("pom.xml")) {
    const version = (await read("pom.xml")).match(/<java\.version>(\d+)</)?.[1];
    return `maven:3.9-eclipse-temurin-${version ?? "21"}`;
  }
  if (names.has("build.gradle") || names.has("build.gradle.kts")) return "gradle:8-jdk21";
  if (names.has("Cargo.toml")) return "rust:1";
  if (names.has("Gemfile")) return "ruby:3";
  if (names.has("composer.json")) return "composer:2";
  return null;
}

function pythonRunner(names: Set<string>): string {
  if (names.has("uv.lock")) return "uv run python";
  if (names.has("poetry.lock")) return "poetry run python";
  return process.platform === "win32" ? ".venv\\Scripts\\python" : ".venv/bin/python";
}

function pythonInstall(names: Set<string>, python: string): string {
  if (names.has("uv.lock")) return "uv sync --frozen";
  if (names.has("poetry.lock")) return "poetry install --no-interaction";
  const requirements = ["requirements-dev.txt", "dev-requirements.txt", "requirements.txt"].find((file) =>
    names.has(file),
  );
  // Wheels only, which is pip's nearest match to --ignore-scripts: nothing runs setup.py.
  const packages = requirements ? `--only-binary=:all: -r ${requirements}` : "-e .";
  return `python -m venv .venv && ${python} -m pip install ${packages}`;
}

function suggestCommands(
  packageManager: string | null,
  scripts: Record<string, string>,
  names: Set<string>,
  dependencies: Dependency[],
): SuggestedCommand[] {
  const commands: SuggestedCommand[] = [];
  const add = (name: string, command: string, kind: SuggestedCommand["kind"]): void => {
    commands.push({ name, command, kind });
  };
  if (names.has("package.json")) {
    const pm =
      packageManager && ["npm", "pnpm", "yarn", "bun"].includes(packageManager) ? packageManager : "npm";
    const frozen: Record<string, string> = {
      npm: names.has("package-lock.json") ? "npm ci --ignore-scripts" : "npm install --ignore-scripts",
      pnpm: "pnpm install --frozen-lockfile --ignore-scripts",
      yarn: "yarn install --frozen-lockfile --ignore-scripts",
      bun: "bun install --frozen-lockfile --ignore-scripts",
    };
    add("install", frozen[pm]!, "install");
    const run = pm === "npm" || pm === "bun" ? `${pm} run` : pm;
    const pick = (candidates: string[]): string | undefined => candidates.find((script) => scripts[script]);
    const typecheck = pick(["typecheck", "type-check", "check-types", "tsc"]);
    if (typecheck) add("typecheck", `${run} ${typecheck}`, "typecheck");
    else if (dependencies.some((dep) => dep.name === "typescript"))
      add("typecheck", "npx tsc --noEmit", "typecheck");
    const lint = pick(["lint"]);
    if (lint) add("lint", `${run} ${lint}`, "lint");
    const test = pick(["test:ci", "test:unit", "test"]);
    if (test && !/no test specified/.test(scripts[test] ?? "")) add("test", `${run} ${test}`, "test");
    const build = pick(["build"]);
    if (build) add("build", `${run} ${build}`, "build");
  }
  const isPython = names.has("pyproject.toml") || names.has("requirements.txt") || names.has("manage.py");
  // Checks run in a fresh directory, so a Python project needs its packages installed there too.
  const python = pythonRunner(names);
  if (isPython) add("install", pythonInstall(names, python), "install");
  if (names.has("pyproject.toml") || names.has("requirements.txt")) {
    if (dependencies.some((dep) => dep.name === "pytest")) add("test", `${python} -m pytest -q`, "test");
    if (dependencies.some((dep) => dep.name === "ruff")) add("lint", `${python} -m ruff check .`, "lint");
    if (dependencies.some((dep) => dep.name === "mypy")) add("typecheck", `${python} -m mypy .`, "typecheck");
  }
  if (names.has("manage.py")) add("test", `${python} manage.py test`, "test");
  if (names.has("go.mod")) {
    add("build", "go build ./...", "build");
    add("lint", "go vet ./...", "lint");
    add("test", "go test ./...", "test");
  }
  if (names.has("Cargo.toml")) {
    add("typecheck", "cargo check --all-targets", "typecheck");
    add("test", "cargo test", "test");
  }
  if (names.has("Gemfile")) add("test", "bundle exec rspec", "test");
  if (names.has("composer.json")) add("test", "vendor/bin/phpunit", "test");
  const isWindows = process.platform === "win32";
  if (names.has("pom.xml")) {
    const maven = names.has("mvnw") ? (isWindows ? "mvnw.cmd" : "./mvnw") : "mvn";
    add("test", `${maven} -q test`, "test");
  }
  if (names.has("build.gradle") || names.has("build.gradle.kts"))
    add("test", isWindows ? "gradlew.bat test" : "./gradlew test", "test");
  return commands;
}

export async function profileRepo(root: string, maxFileBytes: number): Promise<RepoProfile> {
  const files = await walkRepo(root);
  const rootNames = new Set(files.filter((file) => !file.rel.includes("/")).map((file) => file.rel));
  const allNames = new Set(files.map((file) => path.posix.basename(file.rel)));

  const dependencies: Dependency[] = [];
  const manifests = files.filter((file) => isManifest(file.rel) && file.rel.split("/").length <= 4);
  for (const manifest of manifests.slice(0, 200)) {
    const text = await readText(path.join(root, manifest.rel), maxFileBytes);
    if (text) dependencies.push(...parseManifest(manifest.rel, text));
  }

  const stack: Partial<Record<Category, string[]>> = {};
  const addStack = (category: Category, name: string): void => {
    const bucket = stack[category] ?? [];
    if (!bucket.includes(name)) bucket.push(name);
    stack[category] = bucket;
  };
  for (const dep of dependencies) {
    for (const tech of technologiesFor(dep.ecosystem, dep.name)) {
      addStack(tech.category, tech.name);
    }
  }
  if (allNames.has("manage.py")) addStack("backend_framework", "django");
  if (files.some((file) => /(^|\/)tailwind\.config\./.test(file.rel))) addStack("styling", "tailwind");
  if (allNames.has("components.json")) addStack("ui_kit", "shadcn-ui");
  if (files.some((file) => file.ext === ".module.css" || file.rel.endsWith(".module.css")))
    addStack("styling", "css-modules");

  const packageJsonPath = path.join(root, "package.json");
  const rootPackage = (await pathExists(packageJsonPath))
    ? parseJsonc<Record<string, unknown>>(await readFile(packageJsonPath, "utf8"))
    : null;
  const scripts = (rootPackage?.scripts ?? {}) as Record<string, string>;

  const packages = manifests
    .filter((file) => path.posix.basename(file.rel) === "package.json" && file.rel.includes("/"))
    .map((file) => path.posix.dirname(file.rel));
  const monorepoTool = rootNames.has("pnpm-workspace.yaml")
    ? "pnpm"
    : rootNames.has("turbo.json")
      ? "turborepo"
      : rootNames.has("nx.json")
        ? "nx"
        : rootPackage?.workspaces
          ? "workspaces"
          : null;
  const packageManager = detectPackageManager(rootNames, rootPackage);
  const languages = languageShares(files);

  return {
    root,
    fileCount: files.length,
    languages: languages.slice(0, 12),
    packageManager,
    monorepo: { tool: monorepoTool, packages: monorepoTool ? packages.slice(0, 80) : [] },
    stack,
    dependencies,
    license_files: files
      .filter((file) => /(^|\/)(LICEN[CS]E|COPYING|NOTICE)(\.[a-z]+)?$/i.test(file.rel))
      .map((file) => file.rel)
      .slice(0, 40),
    conventions: await readConventions(root, files),
    design_system: await readDesignSystem(root, files),
    has_backend: Boolean(
      stack.backend_framework?.length || stack.orm?.length || allNames.has("schema.prisma"),
    ),
    has_frontend: Boolean(stack.ui_framework?.length || stack.meta_framework?.length),
    suggested_commands: suggestCommands(packageManager, scripts, rootNames, dependencies),
    suggested_docker_image: await suggestDockerImage(root, rootNames),
    suggested_services: await suggestServices(root, files, dependencies),
    infrastructure: detectInfrastructure(files),
    top_level: [...new Set(files.map((file) => file.rel.split("/")[0]!))].slice(0, 60),
    scripts,
  };
}

/** Compact view for tool output: the full dependency list can run to thousands of rows in a monorepo. */
export function summarizeProfile(profile: RepoProfile, dependencyLimit = 120): Record<string, unknown> {
  const { dependencies, root: _root, ...rest } = profile;
  return {
    ...rest,
    dependency_count: dependencies.length,
    dependencies: dependencies
      .slice(0, dependencyLimit)
      .map((dep) => `${dep.ecosystem}:${dep.name}@${dep.version}${dep.dev ? " (dev)" : ""}`),
    dependencies_truncated: dependencies.length > dependencyLimit,
  };
}
