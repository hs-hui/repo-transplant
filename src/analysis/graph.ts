import { builtinModules } from "node:module";
import path from "node:path";
import { type RepoFile, walkRepo } from "../repo/walk.js";
import { parseJsonc, readText } from "../util/fsx.js";
import { extractImports, type ImportLanguage, importLanguage, type RawImport } from "./imports.js";
import type { Ecosystem } from "./manifests.js";

export interface GraphNode {
  file: RepoFile;
  internal: Set<string>;
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
  goModule: string | null;
  goRoot: string;
  phpNamespaces: [string, string][];
  jvmSuffix: Map<string, string>;
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

function resolveGo(item: RawImport, ctx: ResolveContext): { internals?: string[]; external?: string } {
  const spec = item.specifier;
  if (ctx.goModule && (spec === ctx.goModule || spec.startsWith(`${ctx.goModule}/`))) {
    const dir = posixJoin(ctx.goRoot, spec.slice(ctx.goModule.length).replace(/^\//, ""));
    const files = (ctx.byDir.get(dir) ?? []).filter(
      (file) => file.endsWith(".go") && !file.endsWith("_test.go"),
    );
    return { internals: files };
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
  if (spec.startsWith("mod:")) {
    const name = spec.slice(4);
    const stem = path.posix.basename(rel, ".rs");
    const base = stem === "mod" || stem === "lib" || stem === "main" ? fromDir : posixJoin(fromDir, stem);
    const hit = tryFile(posixJoin(base, name), ctx, [".rs", "/mod.rs"]);
    return hit ? { internal: hit } : {};
  }
  const parts = spec.split("::");
  const head = parts[0]!;
  if (head === "std" || head === "core" || head === "alloc") return {};
  if (head === "crate" || head === "self" || head === "super") {
    let base: string;
    if (head === "crate") {
      const srcIndex = rel.lastIndexOf("src/");
      base = srcIndex === -1 ? "src" : rel.slice(0, srcIndex + 3);
    } else if (head === "self") {
      base = fromDir;
    } else {
      base = path.posix.dirname(fromDir) === "." ? "" : path.posix.dirname(fromDir);
    }
    for (let end = parts.length; end > 1; end--) {
      const hit = tryFile(posixJoin(base, parts.slice(1, end).join("/")), ctx, [".rs", "/mod.rs"]);
      if (hit) return { internal: hit };
    }
    return {};
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

function resolveJvm(item: RawImport, ctx: ResolveContext): { internal?: string; external?: string } {
  const hit = ctx.jvmSuffix.get(item.specifier.replace(/\./g, "/"));
  if (hit) return { internal: hit };
  const parts = item.specifier.split(".");
  if (["java", "javax", "kotlin", "jdk", "sun"].includes(parts[0]!)) return {};
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
  for (const file of files) {
    const dir = path.posix.dirname(file.rel) === "." ? "" : path.posix.dirname(file.rel);
    const list = byDir.get(dir);
    if (list) list.push(file.rel);
    else byDir.set(dir, [file.rel]);
    if (file.ext === ".java" || file.ext === ".kt") {
      const noExt = file.rel.slice(0, -file.ext.length);
      const anchor = noExt.search(/(^|\/)(com|org|io|net|dev|app|me)\//);
      if (anchor !== -1) jvmSuffix.set(noExt.slice(anchor === 0 ? 0 : anchor + 1), file.rel);
    }
  }

  const workspacePackages = new Map<string, string>();
  for (const file of files.filter((item) => path.posix.basename(item.rel) === "package.json")) {
    const text = await readText(path.join(root, file.rel), maxBytes);
    const name = text ? parseJsonc<{ name?: string }>(text)?.name : undefined;
    const dir = path.posix.dirname(file.rel);
    if (name && dir !== ".") workspacePackages.set(name, dir);
  }

  let goModule: string | null = null;
  let goRoot = "";
  const goMod = files.find((file) => path.posix.basename(file.rel) === "go.mod");
  if (goMod) {
    const text = await readText(path.join(root, goMod.rel), maxBytes);
    goModule = text?.match(/^module\s+(\S+)/m)?.[1] ?? null;
    const dir = path.posix.dirname(goMod.rel);
    goRoot = dir === "." ? "" : dir;
  }

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
    goModule,
    goRoot,
    phpNamespaces,
    jvmSuffix,
  };
}

function connect(
  node: GraphNode,
  rel: string,
  language: ImportLanguage,
  imports: RawImport[],
  ctx: ResolveContext,
): void {
  const fromDir = path.posix.dirname(rel) === "." ? "" : path.posix.dirname(rel);
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
        result = resolveJvm(item, ctx);
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
      const node: GraphNode = { file, internal: new Set(), external: new Set(), unresolved: [] };
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
      if (language) connect(node, file.rel, language, extractImports(file.rel, text), ctx);
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
