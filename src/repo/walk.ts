import { readdir, stat } from "node:fs/promises";
import path from "node:path";

/** Skipped at any depth: dependencies, caches and tool state. */
export const IGNORED_DIRS = new Set([
  ".git",
  ".hg",
  ".svn",
  "node_modules",
  "bower_components",
  "jspm_packages",
  ".next",
  ".nuxt",
  ".svelte-kit",
  ".output",
  ".vercel",
  ".turbo",
  ".cache",
  ".parcel-cache",
  "coverage",
  "__pycache__",
  ".pytest_cache",
  ".mypy_cache",
  ".ruff_cache",
  ".tox",
  ".venv",
  "venv",
  ".gradle",
  ".idea",
  ".vscode",
  "Pods",
  "DerivedData",
  ".dart_tool",
  ".transplant",
]);

/** Generated or vendored only beside a project manifest. `src/build/` or `lib/vendor/` is ordinary code. */
const PROJECT_LEVEL_DIRS = new Set(["vendor", "third_party", "dist", "build", "out", "target"]);
const PROJECT_MARKER =
  /^(package\.json|go\.mod|Cargo\.toml|pyproject\.toml|setup\.py|composer\.json|pom\.xml|Gemfile|build\.gradle(\.kts)?)$/;
/** A full walk still skips these, which hold no authored code and can run to millions of files. */
const ALWAYS_SKIPPED = new Set([".git", ".hg", ".svn", "node_modules", "bower_components", "jspm_packages"]);

export const LANGUAGE_BY_EXT: Record<string, string> = {
  ".ts": "TypeScript",
  ".tsx": "TypeScript",
  ".mts": "TypeScript",
  ".cts": "TypeScript",
  ".js": "JavaScript",
  ".jsx": "JavaScript",
  ".mjs": "JavaScript",
  ".cjs": "JavaScript",
  ".vue": "Vue",
  ".svelte": "Svelte",
  ".astro": "Astro",
  ".py": "Python",
  ".go": "Go",
  ".rs": "Rust",
  ".rb": "Ruby",
  ".php": "PHP",
  ".java": "Java",
  ".kt": "Kotlin",
  ".kts": "Kotlin",
  ".cs": "C#",
  ".swift": "Swift",
  ".dart": "Dart",
  ".css": "CSS",
  ".scss": "SCSS",
  ".sass": "SCSS",
  ".less": "Less",
  ".html": "HTML",
  ".sql": "SQL",
  ".graphql": "GraphQL",
  ".gql": "GraphQL",
  ".prisma": "Prisma",
  ".proto": "Protobuf",
};

export type FileClass =
  | "source"
  | "test"
  | "config"
  | "doc"
  | "asset"
  | "style"
  | "lock"
  | "generated"
  | "other";

const LOCK_FILES = new Set([
  "package-lock.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "bun.lockb",
  "bun.lock",
  "poetry.lock",
  "Pipfile.lock",
  "uv.lock",
  "Cargo.lock",
  "go.sum",
  "Gemfile.lock",
  "composer.lock",
  "gradle.lockfile",
]);
const ASSET_EXT = new Set(
  ".png .jpg .jpeg .gif .webp .avif .ico .svg .mp3 .mp4 .webm .woff .woff2 .ttf .otf .eot .pdf".split(" "),
);
const STYLE_EXT = new Set([".css", ".scss", ".sass", ".less", ".styl"]);
const CONFIG_EXT = new Set([".json", ".yaml", ".yml", ".toml", ".ini", ".cfg", ".env", ".xml"]);
const DOC_EXT = new Set([".md", ".mdx", ".rst", ".txt", ".adoc"]);

export const isLockFile = (rel: string): boolean => LOCK_FILES.has(path.posix.basename(rel));

export function classifyFile(rel: string): FileClass {
  const base = path.posix.basename(rel);
  const ext = path.posix.extname(base).toLowerCase();
  if (LOCK_FILES.has(base)) return "lock";
  if (
    /\.(min|bundle|generated|gen|pb)\.[a-z]+$/i.test(base) ||
    /(^|\/)(generated|__generated__)\//.test(rel)
  ) {
    return "generated";
  }
  if (
    /(^|\/)(__tests__|__mocks__|tests?|spec|specs|e2e|cypress|playwright)\//i.test(rel) ||
    /\.(test|spec|e2e|cy)\.[a-z]+$/i.test(base) ||
    /(^test_.*\.py|_test\.(py|go|rb)|_spec\.rb|Tests?\.(java|kt|cs|php))$/.test(base)
  ) {
    return "test";
  }
  if (ASSET_EXT.has(ext)) return "asset";
  if (STYLE_EXT.has(ext)) return "style";
  if (DOC_EXT.has(ext)) return "doc";
  if (CONFIG_EXT.has(ext) || base.startsWith(".") || /\.config\.[cm]?[jt]s$/.test(base)) return "config";
  if (LANGUAGE_BY_EXT[ext]) return "source";
  return "other";
}

export interface RepoFile {
  rel: string;
  size: number;
  ext: string;
  fileClass: FileClass;
}

export interface WalkOptions {
  maxFiles?: number;
  /** Include vendored, generated and editor directories, for security and license checks. */
  full?: boolean;
}

/** Lists regular files using posix relative paths. Symbolic links are never followed. */
export async function walkRepo(root: string, options: WalkOptions = {}): Promise<RepoFile[]> {
  const maxFiles = options.maxFiles ?? 200_000;
  const files: RepoFile[] = [];
  const stack: string[] = [""];
  while (stack.length > 0 && files.length < maxFiles) {
    const relDir = stack.pop()!;
    const entries = await readdir(path.join(root, relDir), { withFileTypes: true }).catch(() => []);
    const isProject = relDir === "" || entries.some((entry) => PROJECT_MARKER.test(entry.name));
    for (const entry of entries) {
      const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        const skip = options.full
          ? ALWAYS_SKIPPED.has(entry.name)
          : IGNORED_DIRS.has(entry.name) || (isProject && PROJECT_LEVEL_DIRS.has(entry.name));
        if (!skip) stack.push(rel);
      } else if (entry.isFile()) {
        const info = await stat(path.join(root, rel)).catch(() => null);
        if (!info) continue;
        const ext = path.posix.extname(entry.name).toLowerCase();
        files.push({ rel, size: info.size, ext, fileClass: classifyFile(rel) });
        if (files.length >= maxFiles) break;
      }
    }
  }
  return files.sort((a, b) => (a.rel < b.rel ? -1 : 1));
}
