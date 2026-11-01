import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, realpath, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { TransplantError } from "./errors.js";

export const toPosix = (value: string): string => value.split(path.sep).join("/");

export function sha256(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

export const randomId = (bytes = 4): string => randomBytes(bytes).toString("hex");

/** Runs a task per item, at most `limit` at a time, and keeps the results in order. */
export async function mapLimit<T, R>(items: T[], limit: number, task: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next++;
      results[index] = await task(items[index]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

export async function pathExists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

/** Rejects absolute paths, traversal and Windows device or stream tricks in repository-relative paths. */
export function assertSafeRelative(rel: string): string {
  const normalized = rel.replace(/\\/g, "/").replace(/^\.\//, "");
  const segments = normalized.split("/");
  if (
    !normalized ||
    normalized.startsWith("/") ||
    /^[a-zA-Z]:/.test(normalized) ||
    normalized.includes("\0") ||
    segments.some((segment) => segment === ".." || segment.includes(":"))
  ) {
    throw new TransplantError("unsafe_path", `Path must stay inside the repository: ${rel}`);
  }
  return normalized;
}

/** Resolves a repository-relative path and verifies the real location is still inside the root. */
export async function resolveInside(root: string, rel: string): Promise<string> {
  const safe = assertSafeRelative(rel);
  const candidate = path.join(root, safe);
  const realRoot = await realpath(root);
  let real: string;
  try {
    real = await realpath(candidate);
  } catch {
    throw new TransplantError("not_found", `File not found: ${safe}`);
  }
  if (real !== realRoot && !real.startsWith(realRoot + path.sep)) {
    throw new TransplantError("unsafe_path", `Path escapes the repository: ${safe}`);
  }
  return real;
}

export function isBinary(buffer: Buffer): boolean {
  const sample = buffer.subarray(0, Math.min(buffer.length, 8000));
  return sample.includes(0);
}

/** Reads a UTF-8 text file, returning null when it is binary, oversized or unreadable. */
export async function readText(file: string, maxBytes: number): Promise<string | null> {
  try {
    const info = await stat(file);
    if (!info.isFile() || info.size > maxBytes) return null;
    const buffer = await readFile(file);
    return isBinary(buffer) ? null : buffer.toString("utf8");
  } catch {
    return null;
  }
}

export async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${randomId()}.tmp`;
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temp, file);
}

export async function readJson<T>(file: string): Promise<T> {
  return JSON.parse(await readFile(file, "utf8")) as T;
}

/** Stable JSON used for hashing: object keys are sorted so equal content hashes equally. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, entry]) => [key, sortKeys(entry)]),
    );
  }
  return value;
}

export function parseJsonc<T = unknown>(text: string): T | null {
  // Walk the text so comment markers inside strings, such as "http://x" or "@/*", survive.
  let out = "";
  let inString = false;
  // Package managers skip a byte order mark, so the audit has to read past it too.
  for (let i = text.charCodeAt(0) === 0xfeff ? 1 : 0; i < text.length; i++) {
    const ch = text[i]!;
    if (inString) {
      out += ch;
      if (ch === "\\") out += text[++i] ?? "";
      else if (ch === '"') inString = false;
    } else if (ch === '"') {
      inString = true;
      out += ch;
    } else if (ch === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
    } else if (ch === "/" && text[i + 1] === "*") {
      i = text.indexOf("*/", i + 2);
      if (i === -1) break;
      i++;
    } else {
      out += ch;
    }
  }
  try {
    return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1")) as T;
  } catch {
    return null;
  }
}
