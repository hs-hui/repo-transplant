import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { fetchSnapshot, loadSnapshot, parseSource } from "../src/repo/fetch.js";
import { TransplantError } from "../src/util/errors.js";
import { assertSafeRelative, parseJsonc, resolveInside } from "../src/util/fsx.js";
import { createRepo, gitIn, tempDir, testConfig, writeFiles } from "./helpers.js";

const config = testConfig();
const code = (fn: () => unknown): string | undefined => {
  try {
    fn();
  } catch (error) {
    return (error as TransplantError).code;
  }
  return undefined;
};

describe("parseSource", () => {
  it.each([
    ["https://github.com/acme/app", "acme", "app"],
    ["https://github.com/acme/app.git", "acme", "app"],
    ["acme/app", "acme", "app"],
    ["git@github.com:acme/app.git", "acme", "app"],
    ["ssh://git@github.com/acme/app.git", "acme", "app"],
  ])("accepts %s", (input, owner, repo) => {
    const parsed = parseSource(input, config);
    expect(parsed).toMatchObject({ owner, repo, url: `https://github.com/${owner}/${repo}.git` });
  });

  it("reads ref and subdirectory from tree URLs", () => {
    const parsed = parseSource("https://github.com/acme/app/tree/main/packages/ui", config);
    expect(parsed).toMatchObject({ ref: "main", subdir: "packages/ui" });
  });

  it.each([
    ["https://evil.example/acme/app", "host_not_allowed"],
    ["http://github.com/acme/app", "invalid_source"],
    ["file:///etc/passwd", "invalid_source"],
    ["ext::sh -c whoami", "invalid_source"],
    ["https://user:token@github.com/acme/app", "invalid_source"],
    ["https://github.com/acme", "invalid_source"],
    ["https://github.com/acme/app;rm", "invalid_source"],
  ])("rejects %s", (input, expected) => {
    expect(code(() => parseSource(input, config))).toBe(expected);
  });

  it("rejects local paths unless explicitly allowed", () => {
    const local = path.resolve("some/repo");
    expect(code(() => parseSource(local, config))).toBeDefined();
    expect(parseSource(local, config, true).kind).toBe("local");
  });

  it("honors RT_ALLOWED_HOSTS", () => {
    const custom = { ...config, allowedHosts: ["git.internal.example"] };
    expect(parseSource("https://git.internal.example/a/b", custom).host).toBe("git.internal.example");
    expect(code(() => parseSource("acme/app", custom))).toBe("host_not_allowed");
  });
});

describe("fetchSnapshot", () => {
  it("creates a read-only snapshot pinned to one commit, without git metadata", async () => {
    const repo = createRepo({ "index.js": "console.log(1);\n" });
    const snapshot = await fetchSnapshot(parseSource(repo, config, true), config);
    expect(snapshot.sha).toBe(gitIn(repo, "rev-parse", "HEAD").trim());
    expect(readFileSync(path.join(snapshot.root, "index.js"), "utf8")).toContain("console.log");
    expect(existsSync(path.join(snapshot.root, ".git"))).toBe(false);
    expect((await loadSnapshot(snapshot.id, config)).sha).toBe(snapshot.sha);
  });

  it("does not run hooks from the source or materialize symlinks", async () => {
    const repo = createRepo({ "a.txt": "data\n" });
    const marker = path.join(tempDir(), "pwned");
    writeFiles(repo, { ".githooks/post-checkout": `#!/bin/sh\ntouch "${marker}"\n` });
    gitIn(repo, "config", "core.hooksPath", ".githooks");
    gitIn(repo, "add", "-A");
    gitIn(
      repo,
      "update-index",
      "--add",
      "--cacheinfo",
      "120000",
      gitIn(repo, "hash-object", "-w", "--stdin", "--path=link").trim() ||
        "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391",
      "link",
    );
    gitIn(repo, "commit", "-q", "-m", "hook");
    const snapshot = await fetchSnapshot(parseSource(repo, config, true), config);
    expect(existsSync(marker)).toBe(false);
    expect(existsSync(path.join(snapshot.root, ".githooks/post-checkout"))).toBe(true);
  });

  it("rejects refs that look like options", async () => {
    const repo = createRepo({ "a.txt": "x\n" });
    await expect(
      fetchSnapshot(parseSource(repo, config, true), config, { ref: "--upload-pack=touch" }),
    ).rejects.toMatchObject({
      code: "invalid_ref",
    });
  });

  it("reports a missing subdirectory", async () => {
    const repo = createRepo({ "a.txt": "x\n" });
    await expect(
      fetchSnapshot(parseSource(repo, config, true), config, { subdir: "nope" }),
    ).rejects.toMatchObject({
      code: "not_found",
    });
  });
});

describe("path safety", () => {
  it.each(["../x", "a/../../x", "/etc/passwd", "C:/Windows", "a:b", "x\0y"])("rejects %s", (rel) => {
    expect(code(() => assertSafeRelative(rel))).toBe("unsafe_path");
  });

  it("resolves files inside the root only", async () => {
    const root = tempDir();
    writeFiles(root, { "a/b.txt": "ok" });
    expect(await resolveInside(root, "a/b.txt")).toContain("b.txt");
    await expect(resolveInside(root, "../outside")).rejects.toBeInstanceOf(TransplantError);
    await expect(resolveInside(root, "missing.txt")).rejects.toMatchObject({ code: "not_found" });
  });
});

describe("parseJsonc", () => {
  it("keeps comment-like text inside strings", () => {
    const parsed = parseJsonc<{ a: string; b: string[] }>(`{
      // comment
      "a": "http://x/*y*/", /* block */
      "b": ["@/*",],
    }`);
    expect(parsed).toEqual({ a: "http://x/*y*/", b: ["@/*"] });
  });
});
