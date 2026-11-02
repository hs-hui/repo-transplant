import { createHash, randomBytes } from "node:crypto";
import { mkdir, open, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
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

/** What real text does not hold. Random bytes behind a byte order mark decode to this. */
const NOT_TEXT = /[\u0000-\u0008\u000E-\u001F]|\p{Cs}/u;

/** Decodes UTF-8 or byte-order-marked UTF-16, returning null for binary content. */
export function decodeText(buffer: Buffer): string | null {
  const little = buffer[0] === 0xff && buffer[1] === 0xfe;
  if (!little && !(buffer[0] === 0xfe && buffer[1] === 0xff)) {
    return isBinary(buffer) ? null : buffer.toString("utf8");
  }
  if (little && buffer[2] === 0 && buffer[3] === 0) return null;
  const even = buffer.subarray(0, buffer.length & ~1);
  const text = (little ? even : Buffer.from(even).swap16()).toString("utf16le").slice(1);
  return NOT_TEXT.test(text) ? null : text;
}

/** Reads a text file, returning null when it is binary, oversized or unreadable. */
export async function readText(file: string, maxBytes: number): Promise<string | null> {
  try {
    const info = await stat(file);
    if (!info.isFile() || info.size > maxBytes) return null;
    return decodeText(await readFile(file));
  } catch {
    return null;
  }
}

/** Reads the start of a file of any size as text, for headers. */
export async function readHead(file: string, bytes: number): Promise<string | null> {
  try {
    const handle = await open(file, "r");
    try {
      const { buffer, bytesRead } = await handle.read(Buffer.alloc(bytes), 0, bytes, 0);
      return decodeText(buffer.subarray(0, bytesRead));
    } finally {
      await handle.close();
    }
  } catch {
    return null;
  }
}

const BUSY_RENAME = new Set(["EPERM", "EACCES", "EBUSY"]);

/** Replaces a file in one step. Windows refuses a rename while another process has the file open. */
export async function writeFileAtomic(file: string, content: string | Buffer): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  // A folder in the way is not going to clear up, so it should not be waited for.
  if ((await stat(file).catch(() => null))?.isDirectory()) {
    throw new TransplantError("not_a_file", `${file} is a folder.`);
  }
  const temp = `${file}.${randomId()}.tmp`;
  try {
    await writeFile(temp, content);
    for (let attempt = 0; ; attempt++) {
      try {
        await rename(temp, file);
        return;
      } catch (error) {
        if (attempt >= 8 || !BUSY_RENAME.has((error as NodeJS.ErrnoException).code ?? "")) throw error;
        await new Promise((resolve) => setTimeout(resolve, 25 * 2 ** attempt));
      }
    }
  } catch (error) {
    await rm(temp, { force: true }).catch(() => undefined);
    throw error;
  }
}

export async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  await writeFileAtomic(file, `${JSON.stringify(value, null, 2)}\n`);
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
    } else if (ch === "}" || ch === "]") {
      // A trailing comma is dropped here, outside strings, where it cannot be part of a value.
      out = `${out.replace(/,\s*$/, "")}${ch}`;
    } else {
      out += ch;
    }
  }
  try {
    return JSON.parse(out) as T;
  } catch {
    return null;
  }
}
