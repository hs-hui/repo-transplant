import { builtinModules } from "node:module";
import path from "node:path";
import { type RepoFile, walkRepo } from "../repo/walk.js";
import { parseJsonc, readText } from "../util/fsx.js";
import { extractImports, type ImportLanguage, importLanguage, type RawImport } from "./imports.js";
import type { Ecosystem } from "./manifests.js";

export interface GraphNode {
  file: RepoFile;
  internal: Set<string>;
  /** Files of the same package that need no import. They do not count toward how widely a file is used. */
  samePackage: Set<string>;
  external: Set<string>;
  unresolved: string[];
}

export interface RepoGraph {
  root: string;
  files: RepoFile[];
  nodes: Map<string, GraphNode>;
  reverse: Map<string, Set<string>>;
  texts: Map<string, string>;
}

interface AliasRule {
  prefix: string;
  suffix: string;
  targets: string[];
}

interface ResolveContext {
  fileSet: Set<string>;
  byDir: Map<string, string[]>;
  aliases: { base: string; rules: AliasRule[] }[];
  workspacePackages: Map<string, string>;
  goModules: { module: string; root: string }[];
  phpNamespaces: [string, string][];
  jvmSuffix: Map<string, string>;
  jvmPackages: Set<string>;
  goPackages: Map<string, string[]>;
  /** Lookups wildcard imports may still spend, so a hostile repository cannot make them quadratic. */
  wildcardBudget: number;
}

const JS_RESOLVE_EXT = [
  "",
  ".ts",
  ".tsx",
  ".d.ts",
  ".mts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".vue",
  ".svelte",
  ".astro",
  ".json",
  ".css",
  ".scss",
];
const NODE_BUILTINS = new Set(builtinModules);
const PYTHON_STDLIB = new Set(
  "abc aifc argparse array ast asyncio atexit base64 bdb binascii bisect builtins bz2 calendar cgi cmath cmd code codecs collections colorsys compileall concurrent configparser contextlib contextvars copy copyreg cProfile csv ctypes curses dataclasses datetime dbm decimal difflib dis doctest email encodings ensurepip enum errno faulthandler fcntl filecmp fileinput fnmatch fractions ftplib functools gc getopt getpass gettext glob graphlib grp gzip hashlib heapq hmac html http idlelib imaplib importlib inspect io ipaddress itertools json keyword linecache locale logging lzma mailbox marshal math mimetypes mmap modulefinder msvcrt multiprocessing netrc numbers opcode operator optparse os pathlib pdb pickle pickletools pkgutil platform plistlib poplib posix pprint profile pstats pty pwd py_compile pyclbr pydoc queue quopri random re readline reprlib resource rlcompleter runpy sched secrets select selectors shelve shlex shutil signal site smtplib socket socketserver sqlite3 ssl stat statistics string stringprep struct subprocess symtable sys sysconfig syslog tabnanny tarfile tempfile termios textwrap threading time timeit tkinter token tokenize tomllib trace traceback tracemalloc tty turtle types typing unicodedata unittest urllib uuid venv warnings wave weakref webbrowser winreg wsgiref xml xmlrpc zipapp zipfile zipimport zlib zoneinfo __future__".split(
    " ",
  ),
);

const JVM_PACKAGE_ROOTS = new Set(["com", "org", "io", "net", "dev", "app", "me"]);

function posixJoin(dir: string, spec: string): string {
  const joined = path.posix.normalize(path.posix.join(dir, spec));
  return joined === "." ? "" : joined;
}

function tryFile(base: string, ctx: ResolveContext, extensions: string[]): string | null {
  if (base.startsWith("..")) return null;
  for (const ext of extensions) {
    if (ctx.fileSet.has(`${base}${ext}`)) return `${base}${ext}`;
  }
  return null;
}

function resolveJsPath(base: string, ctx: ResolveContext): string | null {
  const stripped = base.replace(/\?.*$/, "");
  const direct = tryFile(stripped, ctx, JS_RESOLVE_EXT);
  if (direct) return direct;
  // TypeScript sources are imported by their output name: ./a.js can mean a.ts, a.tsx or a.d.ts.
  const stem = stripped.match(/^(.*)\.(m|c)?jsx?$/);
  if (stem) {
    const flavor = stem[2] ?? "";
    for (const ext of [`.${flavor}ts`, `.${flavor}tsx`, ".tsx", `.d.${flavor}ts`]) {
      if (ctx.fileSet.has(`${stem[1]}${ext}`)) return `${stem[1]}${ext}`;
    }
  }
  for (const ext of JS_RESOLVE_EXT.slice(1)) {
    const index = stripped ? `${stripped}/index${ext}` : `index${ext}`;
    if (ctx.fileSet.has(index)) return index;
  }
  return null;
}

function externalNpmName(spec: string): string {
  const parts = spec.split("/");
  return spec.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0]!;
}

function resolveJs(
  item: RawImport,
  fromDir: string,
  ctx: ResolveContext,
): { internal?: string; external?: string; unresolved?: string } {
  const spec = item.specifier;
  if (spec.startsWith(".")) {
    const hit = resolveJsPath(posixJoin(fromDir, spec), ctx);
    return hit ? { internal: hit } : { unresolved: spec };
  }
  if (spec.startsWith("/")) {
    const hit = resolveJsPath(spec.slice(1), ctx) ?? resolveJsPath(`public/${spec.slice(1)}`, ctx);
    return hit ? { internal: hit } : { unresolved: spec };
  }
  for (const scope of ctx.aliases) {
    if (scope.base && fromDir !== scope.base && !fromDir.startsWith(`${scope.base}/`)) continue;
    for (const rule of scope.rules) {
      if (!spec.startsWith(rule.prefix) || !spec.endsWith(rule.suffix)) continue;
      const middle = spec.slice(rule.prefix.length, spec.length - rule.suffix.length);
      for (const target of rule.targets) {
        const hit = resolveJsPath(posixJoin(scope.base, target.replace("*", middle)), ctx);
        if (hit) return { internal: hit };
      }
    }
  }
  const pkg = externalNpmName(spec);
  const workspaceDir = ctx.workspacePackages.get(pkg);
  if (workspaceDir !== undefined) {
    const sub = spec.slice(pkg.length).replace(/^\//, "");
    const hit =
      (sub
        ? (resolveJsPath(posixJoin(workspaceDir, sub), ctx) ??
          resolveJsPath(posixJoin(workspaceDir, `src/${sub}`), ctx))
        : null) ??
      resolveJsPath(posixJoin(workspaceDir, "src/index"), ctx) ??
      resolveJsPath(posixJoin(workspaceDir, "index"), ctx);
    if (hit) return { internal: hit };
  }
  if (spec.startsWith("node:") || NODE_BUILTINS.has(pkg)) return {};
  // Bare asset specs such as `~/x` or `@/x` that matched no alias are unresolved rather than packages.
  if (/^[~@#]\//.test(spec)) return { unresolved: spec };
  return { external: pkg };
}

function resolvePython(
  item: RawImport,
  fromDir: string,
  ctx: ResolveContext,
): { internal?: string; external?: string; unresolved?: string } {
  const spec = item.specifier;
  const lookup = (base: string): string | null => tryFile(base, ctx, [".py", "/__init__.py"]);
  if (spec.startsWith(".")) {
    const dots = spec.match(/^\.+/)![0].length;
    let dir = fromDir;
    for (let i = 1; i < dots; i++) dir = path.posix.dirname(dir) === "." ? "" : path.posix.dirname(dir);
    const rest = spec.slice(dots).replace(/\./g, "/");
    const hit = lookup(posixJoin(dir, rest));
    if (hit) return { internal: hit };
    return item.kind === "module" ? {} : { unresolved: spec };
  }
  const modulePath = spec.replace(/\./g, "/");
  let dir = fromDir;
  const roots = ["", "src", "app", "backend"];
  while (true) {
    if (dir) roots.push(dir);
    if (!dir) break;
    dir = path.posix.dirname(dir) === "." ? "" : path.posix.dirname(dir);
  }
  for (const root of roots) {
    const hit = lookup(root ? `${root}/${modulePath}` : modulePath);
    if (hit) return { internal: hit };
  }
  if (item.kind === "module") return {};
  const top = spec.split(".")[0]!;
  if (PYTHON_STDLIB.has(top)) return {};
  return { external: top.toLowerCase().replace(/_/g, "-") };
}

function goPackageFiles(dir: string, ctx: ResolveContext): string[] {
  const known = ctx.goPackages.get(dir);
  if (known) return known;
  const files = (ctx.byDir.get(dir) ?? []).filter(
    (file) => file.endsWith(".go") && !file.endsWith("_test.go"),
  );
  ctx.goPackages.set(dir, files);
  return files;
}

function resolveGo(item: RawImport, ctx: ResolveContext): { internals?: string[]; external?: string } {
  const spec = item.specifier;
  const owner = ctx.goModules.find((entry) => spec === entry.module || spec.startsWith(`${entry.module}/`));
  if (owner) {
    return {
      internals: goPackageFiles(
        posixJoin(owner.root, spec.slice(owner.module.length).replace(/^\//, "")),
        ctx,
      ),
    };
  }
  if (!spec.split("/")[0]!.includes(".")) return {};
  const parts = spec.split("/");
  return { external: parts.slice(0, /^v\d+$/.test(parts[3] ?? "") ? 4 : 3).join("/") };
}

function resolveRust(
  item: RawImport,
  rel: string,
  ctx: ResolveContext,
): { internal?: string; external?: string } {
  const spec = item.specifier;
  const fromDir = path.posix.dirname(rel) === "." ? "" : path.posix.dirname(rel);
  // expr.rs keeps its child modules in expr/; crate roots and mod.rs keep them beside it. Every file
  // directly under tests/, examples/, benches/ and src/bin/ is a crate root of its own.
  const stem = path.posix.basename(rel, ".rs");
  const beside =
    stem === "mod" ||
    stem === "lib" ||
    stem === "main" ||
    /(^|\/)(tests|examples|benches|src\/bin)$/.test(fromDir);
  const moduleDir = beside ? fromDir : posixJoin(fromDir, stem);
  if (spec.startsWith("mod:")) {
    const name = spec.slice(4);
    const hit = tryFile(posixJoin(moduleDir, name), ctx, [".rs", "/mod.rs"]);
    return hit ? { internal: hit } : {};
  }
  const parts = spec.split("::");
  const head = parts[0]!;
  if (head === "std" || head === "core" || head === "alloc") return {};
  if (head === "crate" || head === "self" || head === "super") {
    let base: string;
    let start = 1;
    if (head === "crate") {
      const srcIndex = rel.lastIndexOf("src/");
      base = srcIndex === -1 ? "src" : rel.slice(0, srcIndex + 3);
    } else if (head === "self") {
      base = moduleDir;
    } else {
      base = moduleDir;
      for (start = 0; parts[start] === "super"; start++) {
        base = path.posix.dirname(base) === "." ? "" : path.posix.dirname(base);
      }
    }
    for (let end = parts.length; end > start; end--) {
      const hit = tryFile(posixJoin(base, parts.slice(start, end).join("/")), ctx, [".rs", "/mod.rs"]);
      if (hit) return { internal: hit };
    }
    // `use super::*` names the module itself, which lives beside its directory or at the crate root.
    const own = tryFile(base, ctx, [".rs", "/mod.rs", "/lib.rs", "/main.rs"]);
    return own ? { internal: own } : {};
  }
  return { external: head.replace(/_/g, "-") };
}

function resolveRuby(
  item: RawImport,
  fromDir: string,
  ctx: ResolveContext,
): { internal?: string; external?: string } {
  const spec = item.specifier;
  if (spec.startsWith("./") || spec.startsWith("../")) {
    const hit = tryFile(posixJoin(fromDir, spec), ctx, [".rb", ""]);
    return hit ? { internal: hit } : {};
  }
  const hit = tryFile(`lib/${spec}`, ctx, [".rb"]) ?? tryFile(`app/${spec}`, ctx, [".rb"]);
  return hit ? { internal: hit } : { external: spec.split("/")[0]! };
}

function resolvePhp(
  item: RawImport,
  fromDir: string,
  ctx: ResolveContext,
): { internal?: string; external?: string } {
  const spec = item.specifier;
  if (spec.startsWith("./")) {
    const hit = tryFile(posixJoin(fromDir, spec), ctx, ["", ".php"]);
    return hit ? { internal: hit } : {};
  }
  for (const [namespace, dir] of ctx.phpNamespaces) {
    if (spec.startsWith(namespace)) {
      const hit = tryFile(posixJoin(dir, spec.slice(namespace.length).replace(/\\/g, "/")), ctx, [".php"]);
      if (hit) return { internal: hit };
    }
  }
  const [vendor, name] = spec.split("\\");
  return name ? { external: `${vendor}\\${name}` } : {};
}

function resolveJvm(
  item: RawImport,
  ctx: ResolveContext,
  words: Set<string>,
): { internal?: string; internals?: string[]; external?: string } {
  // A wildcard keeps its trailing dot. It brings in the classes this file names, each in the file named after it.
  const parts = item.specifier.replace(/\.$/, "").split(".");
  const dir = parts.join("/");
  const members: string[] = [];
  const known = item.specifier.endsWith(".") && ctx.jvmPackages.has(dir);
  if (known && ctx.wildcardBudget > 0) {
    ctx.wildcardBudget -= words.size;
    for (const word of words) {
      const member = ctx.jvmSuffix.get(`${dir}/${word}`);
      if (member) members.push(member);
    }
  }
  for (let end = parts.length; end > 0; end--) {
    const hit = ctx.jvmSuffix.get(parts.slice(0, end).join("/"));
    if (hit) return { internals: [...members, hit] };
  }
  if (members.length > 0) return { internals: members };
  if (known || ["java", "javax", "kotlin", "jdk", "sun"].includes(parts[0]!)) return {};
  return { external: parts.slice(0, 3).join(".") };
}

function resolveStyle(
  item: RawImport,
  fromDir: string,
  ctx: ResolveContext,
): { internal?: string; external?: string; unresolved?: string } {
  const spec = item.specifier.replace(/[?#].*$/, "");
  if (/^(https?:)?\/\//.test(spec) || spec.startsWith("data:")) return {};
  if (spec.startsWith("~")) return { external: externalNpmName(spec.slice(1)) };
  const relative = posixJoin(fromDir, spec);
  const dir = path.posix.dirname(relative);
  const base = path.posix.basename(relative);
  const hit =
    tryFile(relative, ctx, ["", ".css", ".scss", ".sass", ".less"]) ??
    tryFile(posixJoin(dir === "." ? "" : dir, `_${base}`), ctx, [".scss", ".sass"]);
  if (hit) return { internal: hit };
  if (spec.startsWith(".") || spec.startsWith("/")) return { unresolved: spec };
  return { external: externalNpmName(spec) };
}

async function loadAliases(
  files: RepoFile[],
  root: string,
  maxBytes: number,
): Promise<ResolveContext["aliases"]> {
  const aliases: ResolveContext["aliases"] = [];
  const configs = files.filter((file) => /(^|\/)(tsconfig[^/]*|jsconfig)\.json$/.test(file.rel));
  for (const config of configs.slice(0, 80)) {
    const text = await readText(path.join(root, config.rel), maxBytes);
    const parsed = text
      ? parseJsonc<{ compilerOptions?: { baseUrl?: string; paths?: Record<string, string[]> } }>(text)
      : null;
    if (!parsed?.compilerOptions) continue;
    const dir = path.posix.dirname(config.rel) === "." ? "" : path.posix.dirname(config.rel);
    const base = posixJoin(dir, parsed.compilerOptions.baseUrl ?? ".");
    const rules: AliasRule[] = [];
    for (const [pattern, targets] of Object.entries(parsed.compilerOptions.paths ?? {})) {
      if (!Array.isArray(targets)) continue;
      const [prefix, suffix = ""] = pattern.split("*");
      rules.push({ prefix: prefix!, suffix, targets: targets.filter((item) => typeof item === "string") });
    }
    if (parsed.compilerOptions.baseUrl) rules.push({ prefix: "", suffix: "", targets: ["*"] });
    if (rules.length > 0) aliases.push({ base, rules });
  }
  // Conventional aliases apply when no config declares them, as in Vite projects that set them in JS.
  const srcBase = files.some((file) => file.rel.startsWith("src/")) ? "src" : "";
  aliases.push({
    base: "",
    rules: [
      { prefix: "@/", suffix: "", targets: [srcBase ? `${srcBase}/*` : "*"] },
      { prefix: "~/", suffix: "", targets: [srcBase ? `${srcBase}/*` : "*"] },
    ],
  });
  return aliases.sort((a, b) => b.base.length - a.base.length);
}

async function buildContext(files: RepoFile[], root: string, maxBytes: number): Promise<ResolveContext> {
  const fileSet = new Set(files.map((file) => file.rel));
  const byDir = new Map<string, string[]>();
  const jvmSuffix = new Map<string, string>();
  const jvmPackages = new Set<string>();
  for (const file of files) {
    const dir = path.posix.dirname(file.rel) === "." ? "" : path.posix.dirname(file.rel);
    const list = byDir.get(dir);
    if (list) list.push(file.rel);
    else byDir.set(dir, [file.rel]);
    if (file.ext === ".java" || file.ext === ".kt") {
      const noExt = file.rel.slice(0, -file.ext.length);
      const segments = noExt.split("/");
      const keys = new Set<string>();
      const sourceRoot = noExt.match(/(?:^|\/)src\/\w+\/(?:java|kotlin)\/(.+)$/);
      if (sourceRoot) keys.add(sourceRoot[1]!);
      // Every package root counts, so a module directory in front of the package does not hide it.
      for (let index = 0; index < segments.length - 1; index++) {
        if (JVM_PACKAGE_ROOTS.has(segments[index]!)) keys.add(segments.slice(index).join("/"));
      }
      for (const key of keys) {
        jvmSuffix.set(key, file.rel);
        jvmPackages.add(path.posix.dirname(key));
      }
    }
  }

  const workspacePackages = new Map<string, string>();
  for (const file of files.filter((item) => path.posix.basename(item.rel) === "package.json")) {
    const text = await readText(path.join(root, file.rel), maxBytes);
    const name = text ? parseJsonc<{ name?: string }>(text)?.name : undefined;
    const dir = path.posix.dirname(file.rel);
    if (name && dir !== ".") workspacePackages.set(name, dir);
  }

  // A nested module can share a prefix with the root, so the longest module path is matched first.
  // A copy of a module path deeper in the tree loses to the shallower one. Vendored modules stay external.
  const goModules: ResolveContext["goModules"] = [];
  for (const file of files.filter((item) => path.posix.basename(item.rel) === "go.mod")) {
    if (/(^|\/)(vendor|third_party)\//.test(file.rel)) continue;
    const text = await readText(path.join(root, file.rel), maxBytes);
    const modulePath = text?.match(/^module\s+"?([^"\s]+)/m)?.[1];
    const dir = path.posix.dirname(file.rel);
    if (modulePath) goModules.push({ module: modulePath, root: dir === "." ? "" : dir });
  }
  goModules.sort((a, b) => b.module.length - a.module.length || a.root.length - b.root.length);

  const phpNamespaces: [string, string][] = [["App\\", "app"]];
  const composerText = fileSet.has("composer.json")
    ? await readText(path.join(root, "composer.json"), maxBytes)
    : null;
  const composer = composerText
    ? parseJsonc<{ autoload?: { "psr-4"?: Record<string, string | string[]> } }>(composerText)
    : null;
  for (const [namespace, dirs] of Object.entries(composer?.autoload?.["psr-4"] ?? {})) {
    for (const dir of [dirs].flat()) {
      if (typeof dir === "string") phpNamespaces.unshift([namespace, dir.replace(/\/$/, "")]);
    }
  }

  return {
    fileSet,
    byDir,
    aliases: await loadAliases(files, root, maxBytes),
    workspacePackages,
    goModules,
    phpNamespaces,
    jvmSuffix,
    jvmPackages,
    goPackages: new Map(),
    wildcardBudget: 100_000_000,
  };
}

/** Files in one Go package that link to each other. Past this a directory is generated code or hostile. */
const MAX_GO_SIBLINGS = 500;

function connect(
  node: GraphNode,
  rel: string,
  language: ImportLanguage,
  text: string,
  ctx: ResolveContext,
): void {
  const fromDir = path.posix.dirname(rel) === "." ? "" : path.posix.dirname(rel);
  const parsed = extractImports(rel, text);
  // A repeated import adds nothing, and each wildcard costs a look at every word in the file.
  const imports =
    language === "jvm" ? [...new Map(parsed.map((item) => [item.specifier, item])).values()] : parsed;
  const words = new Set(language === "jvm" ? text.match(/[A-Za-z_]\w*/g) : []);
  if (language === "jvm") {
    for (const word of words) {
      const sibling = tryFile(posixJoin(fromDir, word), ctx, [".java", ".kt"]);
      if (sibling && sibling !== rel) node.samePackage.add(sibling);
    }
  }
  if (language === "go" && !rel.endsWith("_test.go")) {
    const siblings = goPackageFiles(fromDir, ctx);
    if (siblings.length <= MAX_GO_SIBLINGS) {
      for (const sibling of siblings) if (sibling !== rel) node.samePackage.add(sibling);
    }
  }
  for (const item of imports) {
    let result: { internal?: string; internals?: string[]; external?: string; unresolved?: string };
    switch (language) {
      case "js":
        result = resolveJs(item, fromDir, ctx);
        break;
      case "python":
        result = resolvePython(item, fromDir, ctx);
        break;
      case "go":
        result = resolveGo(item, ctx);
        break;
      case "rust":
        result = resolveRust(item, rel, ctx);
        break;
      case "ruby":
        result = resolveRuby(item, fromDir, ctx);
        break;
      case "php":
        result = resolvePhp(item, fromDir, ctx);
        break;
      case "jvm":
        result = resolveJvm(item, ctx, words);
        break;
      case "style":
        result = resolveStyle(item, fromDir, ctx);
        break;
      default:
        result = {};
    }
    if (result.internal && result.internal !== rel) node.internal.add(result.internal);
    for (const file of result.internals ?? []) if (file !== rel) node.internal.add(file);
    if (result.external) node.external.add(result.external);
    if (result.unresolved) node.unresolved.push(result.unresolved);
  }
}

/** Text kept for search and scanning. Past this, files stay in the graph without their contents. */
const MAX_HELD_TEXT = 256 * 1024 * 1024;
const cache = new Map<string, Promise<RepoGraph>>();

/** Builds the file-level import graph of a repository. Results are cached per snapshot root. */
export function buildGraph(
  root: string,
  maxFileBytes: number,
  options: { useCache?: boolean } = {},
): Promise<RepoGraph> {
  const useCache = options.useCache ?? true;
  const cached = useCache ? cache.get(root) : undefined;
  if (cached) return cached;
  const pending = (async () => {
    const files = await walkRepo(root);
    const ctx = await buildContext(files, root, maxFileBytes);
    const nodes = new Map<string, GraphNode>();
    const reverse = new Map<string, Set<string>>();
    const texts = new Map<string, string>();
    let heldBytes = 0;
    for (const file of files) {
      const node: GraphNode = {
        file,
        internal: new Set(),
        samePackage: new Set(),
        external: new Set(),
        unresolved: [],
      };
      nodes.set(file.rel, node);
      const language = importLanguage(file.rel);
      const readable =
        language || file.fileClass === "source" || file.fileClass === "doc" || file.fileClass === "config";
      if (!readable || file.fileClass === "generated") continue;
      const text = await readText(path.join(root, file.rel), maxFileBytes);
      if (text === null) continue;
      if (heldBytes + text.length <= MAX_HELD_TEXT) {
        texts.set(file.rel, text);
        heldBytes += text.length;
      }
      if (language) connect(node, file.rel, language, text, ctx);
    }
    for (const [rel, node] of nodes) {
      for (const dep of node.internal) {
        const set = reverse.get(dep);
        if (set) set.add(rel);
        else reverse.set(dep, new Set([rel]));
      }
    }
    return { root, files, nodes, reverse, texts };
  })();
  if (useCache) {
    if (cache.size >= 4) cache.delete(cache.keys().next().value!);
    cache.set(root, pending);
    pending.catch(() => cache.delete(root));
  }
  return pending;
}

/** Importers that ship with the product. Tests import their subject heavily, so they do not count. */
export function productionFanIn(graph: RepoGraph, rel: string): number {
  let count = 0;
  for (const importer of graph.reverse.get(rel) ?? []) {
    if (graph.nodes.get(importer)?.file.fileClass !== "test") count++;
  }
  return count;
}

export const ecosystemForFile = (rel: string): Ecosystem | null => {
  switch (importLanguage(rel)) {
    case "js":
    case "style":
      return "npm";
    case "python":
      return "pypi";
    case "go":
      return "go";
    case "rust":
      return "cargo";
    case "ruby":
      return "rubygems";
    case "php":
      return "packagist";
    case "jvm":
      return "maven";
    case "csharp":
      return "nuget";
    default:
      return null;
  }
};
