import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { scanRepository } from "../src/analysis/security.js";
import { MAX_SNAPSHOT_FILES } from "../src/repo/walk.js";
import { tempDir, writeFiles } from "./helpers.js";

const CLEAN = "export const a = 1;\n";
const uncovered = (report: { findings: { rule: string; path: string }[] }) =>
  report.findings.filter((item) => item.rule === "coverage.file_not_scanned");

describe("requested paths the walk does not list", () => {
  it("raises a high coverage finding for a requested file that is not listed", async () => {
    const root = tempDir();
    writeFiles(root, { "src/a.ts": CLEAN });
    const report = await scanRepository(root, {
      maxFileBytes: 1_000_000,
      paths: ["src/a.ts", "src/ghost.ts"],
    });
    expect(report.risk).toBe("caution");
    expect(report.findings).toEqual([
      expect.objectContaining({
        rule: "coverage.file_not_scanned",
        category: "coverage",
        severity: "high",
        path: "src/ghost.ts",
      }),
    ]);
  });

  it("reports a requested file that exists but that the walk skips", async () => {
    const root = tempDir();
    writeFiles(root, { "node_modules/pkg/index.js": "eval(atob(x));\n", "src/a.ts": CLEAN });
    const report = await scanRepository(root, {
      maxFileBytes: 1_000_000,
      paths: ["node_modules/pkg/index.js"],
    });
    expect(uncovered(report).map((item) => item.path)).toEqual(["node_modules/pkg/index.js"]);
    expect(report.risk).not.toBe("clean");
  });

  it("keeps a clean result when every requested file is listed", async () => {
    const root = tempDir();
    writeFiles(root, { "src/a.ts": CLEAN, "src/b.ts": CLEAN });
    const report = await scanRepository(root, { maxFileBytes: 1_000_000, paths: ["src/a.ts"] });
    expect(report.risk).toBe("clean");
    expect(uncovered(report)).toEqual([]);
  });
});

describe("walk limit", () => {
  it("shares one file limit between the fetch check and the walker", () => {
    expect(MAX_SNAPSHOT_FILES).toBe(500_000);
    const fetchSource = readFileSync(path.join("src", "repo", "fetch.ts"), "utf8");
    expect(fetchSource).toContain("MAX_SNAPSHOT_FILES");
    expect(fetchSource).not.toMatch(/500_?000/);
    const walkSource = readFileSync(path.join("src", "repo", "walk.ts"), "utf8");
    expect(walkSource).toContain("options.maxFiles ?? MAX_SNAPSHOT_FILES");
  });

  it("says the listing was cut when it stops at the limit", async () => {
    const root = tempDir();
    writeFiles(root, { "src/a.ts": CLEAN, "src/b.ts": CLEAN, "src/c.ts": CLEAN });
    const report = await scanRepository(root, { maxFileBytes: 1_000_000, maxFiles: 2 });
    expect(report.truncated).toBe(true);
    expect(report.scanned_files).toBe(2);
    expect(uncovered(report).map((item) => item.path)).toEqual(["."]);
    expect(report.risk).not.toBe("clean");
  });

  it("does not report a cut when the listing fits the limit exactly", async () => {
    const root = tempDir();
    writeFiles(root, { "src/a.ts": CLEAN, "src/b.ts": CLEAN, "src/c.ts": CLEAN });
    const report = await scanRepository(root, { maxFileBytes: 1_000_000, maxFiles: 3 });
    expect(report.truncated).toBe(false);
    expect(report.risk).toBe("clean");
  });

  it("reports a requested file that falls past the limit", async () => {
    const root = tempDir();
    writeFiles(root, { "src/a.ts": CLEAN, "src/b.ts": CLEAN });
    const report = await scanRepository(root, {
      maxFileBytes: 1_000_000,
      maxFiles: 1,
      paths: ["src/a.ts", "src/b.ts"],
    });
    expect(uncovered(report).filter((item) => item.path !== ".")).toHaveLength(1);
    expect(report.risk).not.toBe("clean");
  });
});
