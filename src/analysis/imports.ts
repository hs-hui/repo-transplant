import path from "node:path";
import { parse } from "@babel/parser";
import { lineLocator, normalizeNewlines } from "../util/text.js";

export type ImportKind = "static" | "dynamic" | "require" | "reexport" | "style" | "module";

export interface RawImport {
  specifier: string;
  kind: ImportKind;
  line: number;
}

type Node = { type?: string; loc?: { start: { line: number } }; [key: string]: unknown };

const JS_EXT = new Set([".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".mts", ".cts"]);

function stringValue(node: unknown): string | null {
  const candidate = node as Node | undefined;
  if (candidate?.type === "StringLiteral") return candidate.value as string;
  if (candidate?.type === "TemplateLiteral") {
    const quasis = candidate.quasis as Node[];
    const expressions = candidate.expressions as unknown[];
    const value = quasis[0]?.value as { cooked: string } | undefined;
    if (expressions.length === 0 && value) return value.cooked;
  }
  return null;
}

function walkAst(node: Node, visit: (node: Node) => void): void {
  const stack: Node[] = [node];
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (current.type) visit(current);
    for (const key of Object.keys(current)) {
      if (key === "loc" || key === "extra" || key === "comments" || key === "tokens") continue;
      const value = current[key];
      if (Array.isArray(value)) {
        for (const item of value) if (item && typeof item === "object") stack.push(item as Node);
      } else if (value && typeof value === "object") {
        stack.push(value as Node);
      }
    }
  }
}

function regexJsImports(text: string): RawImport[] {
  const imports: RawImport[] = [];
  const lineOf = lineLocator(text);
  const patterns: [RegExp, ImportKind][] = [
    [/\b(?:import|export)\s+[^'"`;]{0,500}?\bfrom\s*['"]([^'"]+)['"]/g, "static"],
    [/\bimport\s*['"]([^'"]+)['"]/g, "static"],
    [/\bimport\s*\(\s*['"`]([^'"`]+)['"`]\s*\)/g, "dynamic"],
    [/\brequire\s*\(\s*['"`]([^'"`]+)['"`]\s*\)/g, "require"],
  ];
  for (const [pattern, kind] of patterns) {
    for (const match of text.matchAll(pattern)) {
      imports.push({ specifier: match[1]!, kind, line: lineOf(match.index) });
    }
  }
  return imports;
}

export function parseJsImports(text: string, ext: string): RawImport[] {
  const isTs = /\.[cm]?tsx?$/.test(ext);
  const allowJsx = ext !== ".ts" && ext !== ".mts" && ext !== ".cts";
  let ast: Node;
  try {
    ast = parse(text, {
      sourceType: "unambiguous",
      errorRecovery: true,
      allowReturnOutsideFunction: true,
      allowUndeclaredExports: true,
      plugins: [
        ...(isTs ? (["typescript"] as const) : []),
        ...(allowJsx ? (["jsx"] as const) : []),
        "decorators",
      ],
    }) as unknown as Node;
  } catch {
    return regexJsImports(text);
  }

  const imports: RawImport[] = [];
  walkAst(ast, (node) => {
    const line = node.loc?.start.line ?? 1;
    switch (node.type) {
      case "ImportDeclaration": {
        const specifier = stringValue(node.source);
        if (specifier) imports.push({ specifier, kind: "static", line });
        break;
      }
      case "ExportAllDeclaration":
      case "ExportNamedDeclaration": {
        const specifier = node.source ? stringValue(node.source) : null;
        if (specifier) imports.push({ specifier, kind: "reexport", line });
        break;
      }
      case "ImportExpression": {
        const specifier = stringValue(node.source);
        if (specifier) imports.push({ specifier, kind: "dynamic", line });
        break;
      }
      case "TSExternalModuleReference": {
        const specifier = stringValue(node.expression);
        if (specifier) imports.push({ specifier, kind: "require", line });
        break;
      }
      case "CallExpression": {
        const callee = node.callee as Node;
        const args = node.arguments as unknown[];
        const specifier = stringValue(args[0]);
        if (!specifier) break;
        if (callee.type === "Import") imports.push({ specifier, kind: "dynamic", line });
        else if (callee.type === "Identifier" && callee.name === "require") {
          imports.push({ specifier, kind: "require", line });
        }
        break;
      }
    }
  });
  return imports;
}

function extractSfcScripts(text: string): { code: string; ext: string; offset: number }[] {
  const scripts: { code: string; ext: string; offset: number }[] = [];
  const lineOf = lineLocator(text);
  let cursor = 0;
  while (true) {
    const open = text.indexOf("<script", cursor);
    if (open === -1) break;
    const tagEnd = text.indexOf(">", open);
    if (tagEnd === -1) break;
    const close = text.indexOf("</script>", tagEnd);
    if (close === -1) break;
    const lang = text.slice(open, tagEnd).match(/lang=["'](\w+)["']/)?.[1];
    scripts.push({
      code: text.slice(tagEnd + 1, close),
      ext: lang === "ts" || lang === "tsx" ? ".ts" : ".js",
      offset: lineOf(tagEnd) - 1,
    });
    cursor = close + 9;
  }
  if (text.startsWith("---\n")) {
    const end = text.indexOf("\n---", 4);
    if (end !== -1) scripts.push({ code: text.slice(4, end), ext: ".ts", offset: 1 });
  }
  return scripts;
}

/** Drops a # comment, unless the # is inside a quoted string. */
function stripPythonComment(line: string): string {
  let quote = "";
  for (let index = 0; index < line.length; index++) {
    const char = line[index]!;
    if (quote) {
      if (char === "\\") index++;
      else if (char === quote) quote = "";
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (char === "#") {
      return line.slice(0, index);
    }
  }
  return line;
}

const CONTINUED = /\\[ \t]*$/;

/** Blanks triple-quoted strings, whose text can look exactly like an import. */
function withoutPythonBlockStrings(lines: string[]): string[] {
  let open = "";
  return lines.map((line) => {
    let kept = "";
    let rest = line;
    while (true) {
      if (open) {
        const end = rest.indexOf(open);
        if (end === -1) return kept;
        rest = rest.slice(end + 3);
        open = "";
      }
      const next = rest.match(/"""|'''|#/);
      if (!next || next[0] === "#") return kept + rest;
      kept += rest.slice(0, next.index);
      rest = rest.slice(next.index! + 3);
      open = next[0];
    }
  });
}

/** Folds parenthesized import lists and backslash continuations, keeping the statement's line number. */
function foldPythonLines(text: string): string[] {
  const lines = withoutPythonBlockStrings(text.split("\n")).map(stripPythonComment);
  const folded: string[] = [];
  for (let index = 0; index < lines.length; index++) {
    // Only the newest line is looked at, so a statement that never closes stays linear.
    const parts = [lines[index]!];
    const start = index;
    let open = /^\s*from\s+\S+\s+import\s*\(/.test(parts[0]!) && !parts[0]!.includes(")");
    while (index + 1 < lines.length && (open || CONTINUED.test(parts.at(-1)!))) {
      parts[parts.length - 1] = parts.at(-1)!.replace(CONTINUED, "");
      index++;
      parts.push(lines[index]!);
      open &&= !lines[index]!.includes(")");
    }
    folded.push(parts.join(" "));
    for (let blank = start; blank < index; blank++) folded.push("");
  }
  return folded;
}

/** Splits `import a; import b` and drops the header of `if x: import a`, so each statement stands alone. */
function pythonStatements(line: string): string[] {
  return line
    .split(";")
    .map((part) =>
      part.replace(
        /^\s*(?:(?:if|elif|else|try|except|finally|with|for|while)\b[^:]*:\s*)+(?=from\b|import\b)/,
        "",
      ),
    );
}

function parsePythonImports(text: string): RawImport[] {
  const imports: RawImport[] = [];
  const lines = foldPythonLines(text);
  for (let index = 0; index < lines.length; index++) {
    for (const line of pythonStatements(lines[index]!)) {
      const from = line.match(/^\s*from\s+([.\w]+)\s+import\s+(.+)$/);
      if (from) {
        imports.push({ specifier: from[1]!, kind: "static", line: index + 1 });
        const names = from[2]!.replace(/[()]/g, "").split(",");
        for (const name of names) {
          const symbol = name
            .trim()
            .split(/\s+as\s+/)[0]!
            .trim();
          if (/^\w+$/.test(symbol)) {
            const prefix = from[1]!.endsWith(".") ? from[1]! : `${from[1]}.`;
            imports.push({ specifier: `${prefix}${symbol}`, kind: "module", line: index + 1 });
          }
        }
        continue;
      }
      const plain = line.match(/^\s*import\s+(.+)$/);
      if (plain) {
        for (const part of plain[1]!.split(",")) {
          const name = part
            .trim()
            .split(/\s+as\s+/)[0]!
            .trim();
          if (/^[\w.]+$/.test(name)) imports.push({ specifier: name, kind: "static", line: index + 1 });
        }
      }
    }
  }
  return imports;
}

function parseGoImports(text: string): RawImport[] {
  const imports: RawImport[] = [];
  let inBlock = false;
  text.split("\n").forEach((line, index) => {
    if (inBlock) {
      if (/^\s*\)/.test(line)) inBlock = false;
      else {
        const match = line.match(/"([^"]+)"/);
        if (match) imports.push({ specifier: match[1]!, kind: "static", line: index + 1 });
      }
    } else if (/^import\s*\(/.test(line)) {
      inBlock = true;
    } else {
      const single = line.match(/^import\s+(?:[\w.]+\s+)?"([^"]+)"/);
      if (single) imports.push({ specifier: single[1]!, kind: "static", line: index + 1 });
    }
  });
  return imports;
}

const RUST_MAX_LEAVES = 4096;
const RUST_MAX_PATH = 512;

/** Spells out a use tree: `a::{b, c::{d, self}}` gives a::b, a::c::d and a::c. */
function expandRustUse(tree: string, budget: { leaves: number }, prefix = "", depth = 0): string[] {
  const group = tree.indexOf("{");
  if (depth > 16 || prefix.length > RUST_MAX_PATH || budget.leaves <= 0) return [];
  if (group === -1) {
    budget.leaves--;
    const name = tree.replace(/\s+as\s+\w+$/, "").trim();
    const spec = name === "self" ? prefix.slice(0, -2) : `${prefix}${name}`.replace(/(::\*|::)$/, "");
    return spec ? [spec] : [];
  }
  const head = `${prefix}${tree.slice(0, group).trim()}`;
  const branches: string[] = [];
  let nested = 0;
  let from = group + 1;
  const end = tree.lastIndexOf("}");
  for (let index = from; index < end; index++) {
    const char = tree[index];
    if (char === "{") nested++;
    if (char === "}") nested--;
    if (char === "," && nested === 0) {
      branches.push(tree.slice(from, index));
      from = index + 1;
    }
  }
  branches.push(tree.slice(from, end));
  return branches
    .filter((item) => item.trim())
    .flatMap((item) => expandRustUse(item.trim(), budget, head, depth + 1));
}

/** Tells how many inline `mod x { }` blocks surround an offset. Offsets must be asked for in order. */
function inlineModuleDepth(text: string): (offset: number) => number {
  const opens = new Set<number>();
  for (const match of text.matchAll(/\bmod\s+\w+\s*\{/g)) opens.add(match.index + match[0].length - 1);
  const changes: [number, number][] = [];
  const stack: boolean[] = [];
  let depth = 0;
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    if (code === 123) {
      stack.push(opens.has(index));
      if (opens.has(index)) changes.push([index, ++depth]);
    } else if (code === 125 && stack.pop()) {
      changes.push([index, --depth]);
    }
  }
  let next = 0;
  let current = 0;
  return (offset) => {
    while (next < changes.length && changes[next]![0] < offset) current = changes[next++]![1];
    return current;
  };
}

/** Inside an inline module, `super` names something in this same file before it leaves the file. */
function outOfInlineModules(spec: string, depth: number): string | null {
  const parts = spec.split("::");
  let climbed = 0;
  while (climbed < depth && parts[0] === "super") {
    parts.shift();
    climbed++;
  }
  if (climbed === 0) return spec;
  if (parts.length === 0) return null;
  return parts[0] === "super" ? parts.join("::") : `self::${parts.join("::")}`;
}

const RUST_PREFIX = String.raw`^[ \t]*(?:#\[[^\]\n]*\][ \t]*)*(?:pub(?:\([^)\n]*\))?\s+)?`;
const RUST_USE = new RegExp(String.raw`${RUST_PREFIX}use\s+([\s\S]+)`, "m");
const RUST_MOD = new RegExp(String.raw`${RUST_PREFIX}mod\s+(\w+)\s*(?![\s\S])`, "m");

/** A use tree can span lines, so statements are found by their semicolons rather than line by line. */
function parseRustImports(text: string): RawImport[] {
  const imports: RawImport[] = [];
  const statements = text.split(";");
  const local = new Set<string>();
  for (const match of text.matchAll(/\bmod\s+(\w+)\s*[;{]/g)) local.add(match[1]!);
  const depthAt = inlineModuleDepth(text);
  let offset = 0;
  let line = 1;
  const lineAt = (position: number): number => {
    for (; offset < position; offset++) if (text.charCodeAt(offset) === 10) line++;
    return line;
  };
  let start = 0;
  for (const statement of statements) {
    const use = statement.match(RUST_USE);
    const mod = use ? null : statement.match(RUST_MOD);
    if (use) {
      const position = start + use.index!;
      const at = lineAt(position);
      const depth = depthAt(position);
      const tree = use[1]!.replace(/\/\/[^\n]*/g, "");
      for (const spec of expandRustUse(tree, { leaves: RUST_MAX_LEAVES })) {
        const head = spec.split("::")[0]!;
        // Types and macro paths such as `$crate` are never crates.
        if (/^[$A-Z]/.test(head)) continue;
        const specifier = outOfInlineModules(local.has(head) ? `self::${spec}` : spec, depth);
        if (specifier) imports.push({ specifier, kind: "static", line: at });
      }
    } else if (mod) {
      imports.push({ specifier: `mod:${mod[1]}`, kind: "module", line: lineAt(start + mod.index!) });
    }
    start += statement.length + 1;
  }
  return imports;
}

function parseRubyImports(text: string): RawImport[] {
  const imports: RawImport[] = [];
  text.split("\n").forEach((line, index) => {
    const relative = line.match(/^\s*require_relative\s+['"]([^'"]+)['"]/);
    if (relative) imports.push({ specifier: `./${relative[1]}`, kind: "require", line: index + 1 });
    const plain = line.match(/^\s*require\s+['"]([^'"]+)['"]/);
    if (plain) imports.push({ specifier: plain[1]!, kind: "require", line: index + 1 });
  });
  return imports;
}

function parsePhpImports(text: string): RawImport[] {
  const imports: RawImport[] = [];
  text.split("\n").forEach((line, index) => {
    const use = line.match(/^\s*use\s+([A-Za-z_\\][\w\\]*)/);
    if (use) imports.push({ specifier: use[1]!, kind: "static", line: index + 1 });
    const req = line.match(/\b(?:require|include)(?:_once)?\s*\(?\s*(?:__DIR__\s*\.\s*)?['"]([^'"]+)['"]/);
    if (req)
      imports.push({ specifier: `./${req[1]!.replace(/^\/+/, "")}`, kind: "require", line: index + 1 });
  });
  return imports;
}

function parseJvmImports(text: string): RawImport[] {
  const imports: RawImport[] = [];
  text.split("\n").forEach((line, index) => {
    const match = line.match(/^\s*import\s+(?:static\s+)?([\w.]+)(?:\.\*)?\s*;?/);
    if (match) imports.push({ specifier: match[1]!, kind: "static", line: index + 1 });
  });
  return imports;
}

function parseCsharpImports(text: string): RawImport[] {
  const imports: RawImport[] = [];
  text.split("\n").forEach((line, index) => {
    const match = line.match(/^\s*(?:global\s+)?using\s+(?:static\s+)?([\w.]+)\s*;/);
    if (match) imports.push({ specifier: match[1]!, kind: "static", line: index + 1 });
  });
  return imports;
}

function parseStyleImports(text: string): RawImport[] {
  const imports: RawImport[] = [];
  text.split("\n").forEach((line, index) => {
    for (const match of line.matchAll(/@(?:import|use|forward)\s+(?:url\()?['"]([^'"]+)['"]/g)) {
      imports.push({ specifier: match[1]!, kind: "style", line: index + 1 });
    }
    for (const match of line.matchAll(/url\(\s*['"]?(\.{0,2}\/[^'")]+)['"]?\s*\)/g)) {
      imports.push({ specifier: match[1]!, kind: "style", line: index + 1 });
    }
  });
  return imports;
}

export type ImportLanguage =
  | "js"
  | "python"
  | "go"
  | "rust"
  | "ruby"
  | "php"
  | "jvm"
  | "csharp"
  | "style"
  | null;

export function importLanguage(rel: string): ImportLanguage {
  const ext = path.posix.extname(rel).toLowerCase();
  if (JS_EXT.has(ext) || ext === ".vue" || ext === ".svelte" || ext === ".astro") return "js";
  if (ext === ".py") return "python";
  if (ext === ".go") return "go";
  if (ext === ".rs") return "rust";
  if (ext === ".rb") return "ruby";
  if (ext === ".php") return "php";
  if (ext === ".java" || ext === ".kt" || ext === ".kts") return "jvm";
  if (ext === ".cs") return "csharp";
  if (ext === ".css" || ext === ".scss" || ext === ".sass" || ext === ".less") return "style";
  return null;
}

export function extractImports(rel: string, rawText: string): RawImport[] {
  const text = normalizeNewlines(rawText);
  const ext = path.posix.extname(rel).toLowerCase();
  switch (importLanguage(rel)) {
    case "js":
      if (JS_EXT.has(ext)) return parseJsImports(text, ext);
      return extractSfcScripts(text).flatMap((script) =>
        parseJsImports(script.code, script.ext).map((item) => ({ ...item, line: item.line + script.offset })),
      );
    case "python":
      return parsePythonImports(text);
    case "go":
      return parseGoImports(text);
    case "rust":
      return parseRustImports(text);
    case "ruby":
      return parseRubyImports(text);
    case "php":
      return parsePhpImports(text);
    case "jvm":
      return parseJvmImports(text);
    case "csharp":
      return parseCsharpImports(text);
    case "style":
      return parseStyleImports(text);
    default:
      return [];
  }
}
