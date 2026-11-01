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

/** Folds parenthesized import lists onto one line, keeping the statement's line number. */
function foldPythonLines(text: string): string[] {
  const lines = text.split("\n");
  const folded: string[] = [];
  for (let index = 0; index < lines.length; index++) {
    let line = lines[index]!;
    if (/^\s*from\s+\S+\s+import\s*\(/.test(line) && !line.includes(")")) {
      const start = index;
      while (index + 1 < lines.length && index - start < 500) {
        index++;
        line += ` ${lines[index]}`;
        if (lines[index]!.includes(")")) break;
      }
      folded.push(line);
      for (let blank = start; blank < index; blank++) folded.push("");
      continue;
    }
    folded.push(line);
  }
  return folded;
}

function parsePythonImports(text: string): RawImport[] {
  const imports: RawImport[] = [];
  const lines = foldPythonLines(text);
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    const from = line.match(/^\s*from\s+([.\w]+)\s+import\s+(.+)$/);
    if (from) {
      imports.push({ specifier: from[1]!, kind: "static", line: index + 1 });
      const names = from[2]!.replace(/[()]/g, "").split("#")[0]!.split(",");
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
      for (const part of plain[1]!.split("#")[0]!.split(",")) {
        const name = part
          .trim()
          .split(/\s+as\s+/)[0]!
          .trim();
        if (/^[\w.]+$/.test(name)) imports.push({ specifier: name, kind: "static", line: index + 1 });
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

function parseRustImports(text: string): RawImport[] {
  const imports: RawImport[] = [];
  const lines = text.split("\n");
  lines.forEach((line, index) => {
    const use = line.match(/^\s*(?:pub(?:\([^)]*\))?\s+)?use\s+([\w:]+)/);
    if (use) imports.push({ specifier: use[1]!.replace(/::$/, ""), kind: "static", line: index + 1 });
    const mod = line.match(/^\s*(?:pub(?:\([^)]*\))?\s+)?mod\s+(\w+)\s*;/);
    if (mod) imports.push({ specifier: `mod:${mod[1]}`, kind: "module", line: index + 1 });
  });
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
