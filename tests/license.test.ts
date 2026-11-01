import { describe, expect, it } from "vitest";
import { checkLicense, identifyLicenseText, resolveExpression } from "../src/analysis/license.js";
import { AGPL_TEXT, GPL3_TEXT, MIT_TEXT, tempDir, writeFiles } from "./helpers.js";

const MAX = 1_000_000;

function repo(files: Record<string, string>): string {
  const root = tempDir();
  writeFiles(root, files);
  return root;
}

describe("license identification", () => {
  it.each([
    [MIT_TEXT, "MIT"],
    [GPL3_TEXT, "GPL-3.0"],
    [AGPL_TEXT, "AGPL-3.0"],
    ["Apache License\nVersion 2.0, January 2004", "Apache-2.0"],
    ["Mozilla Public License Version 2.0", "MPL-2.0"],
    ["GNU LESSER GENERAL PUBLIC LICENSE\nVersion 3", "LGPL-3.0"],
    ["Business Source License 1.1", "BUSL-1.1"],
    [
      "Redistribution and use in source and binary forms, with or without modification. Neither the name of the copyright holder",
      "BSD-3-Clause",
    ],
    ["Redistribution and use in source and binary forms, with or without modification.", "BSD-2-Clause"],
    ["This is free and unencumbered software released into the public domain.", "Unlicense"],
    ["Our own terms apply.", null],
  ])("identifies %#", (text, expected) => {
    expect(identifyLicenseText(text)).toBe(expected);
  });

  it("resolves SPDX expressions", () => {
    expect(resolveExpression("MIT OR GPL-3.0").spdx).toBe("MIT");
    expect(resolveExpression("MIT AND GPL-3.0").spdx).toBe("GPL-3.0");
    expect(resolveExpression("(MIT OR Apache-2.0) ").class).toBe("permissive");
    expect(resolveExpression("GPL-3.0-only").spdx).toBe("GPL-3.0");
    expect(resolveExpression("GPL-2.0-or-later").class).toBe("strong_copyleft");
  });
});

describe("license verdicts", () => {
  const proprietary = repo({ "package.json": '{"private":true}' });

  it("allows MIT into a proprietary target with attribution", async () => {
    const report = await checkLicense(repo({ LICENSE: MIT_TEXT }), proprietary, { maxFileBytes: MAX });
    expect(report.verdict).toBe("allow_with_conditions");
    expect(report.source.copyright[0]).toContain("Example Author");
    expect(report.target.distribution).toBe("proprietary");
    expect(report.conditions.join(" ")).toContain("copyright notice");
  });

  it("blocks a repository with no license", async () => {
    const report = await checkLicense(repo({ "index.js": "x" }), proprietary, { maxFileBytes: MAX });
    expect(report.verdict).toBe("block");
    expect(report.reasons[0]).toContain("all rights reserved");
  });

  it("blocks GPL into proprietary and allows GPL into GPL", async () => {
    const gpl = repo({ LICENSE: GPL3_TEXT });
    expect((await checkLicense(gpl, proprietary, { maxFileBytes: MAX })).verdict).toBe("block");
    const target = repo({ COPYING: GPL3_TEXT });
    expect((await checkLicense(gpl, target, { maxFileBytes: MAX })).verdict).toBe("allow_with_conditions");
  });

  it("does not treat AGPL as allowed for internal use", async () => {
    const report = await checkLicense(repo({ LICENSE: AGPL_TEXT }), proprietary, {
      maxFileBytes: MAX,
      distribution: "internal_only",
    });
    expect(report.verdict).toBe("block");
  });

  it("downgrades GPL to review for internal-only software", async () => {
    const report = await checkLicense(repo({ LICENSE: GPL3_TEXT }), proprietary, {
      maxFileBytes: MAX,
      distribution: "internal_only",
    });
    expect(report.verdict).toBe("needs_review");
  });

  it("blocks source-available licenses and the Commons Clause", async () => {
    const busl = await checkLicense(repo({ LICENSE: "Business Source License 1.1" }), proprietary, {
      maxFileBytes: MAX,
    });
    expect(busl.verdict).toBe("block");
    const clause = await checkLicense(
      repo({ LICENSE: `Commons Clause License Condition v1.0\n${MIT_TEXT}` }),
      proprietary,
      {
        maxFileBytes: MAX,
      },
    );
    expect(clause.source.class).toBe("source_available");
    expect(clause.verdict).toBe("block");
  });

  it("flags an unrecognized license for a person", async () => {
    const report = await checkLicense(repo({ LICENSE: "Custom terms." }), proprietary, { maxFileBytes: MAX });
    expect(report.verdict).toBe("needs_review");
  });

  it("uses the permissive branch of a dual license", async () => {
    const source = repo({ LICENSE: GPL3_TEXT, "package.json": '{"license":"MIT OR GPL-3.0"}' });
    const report = await checkLicense(source, proprietary, { maxFileBytes: MAX });
    expect(report.source.spdx).toBe("MIT");
  });

  it("escalates when a selected file sits under a stricter nested license", async () => {
    const source = repo({
      LICENSE: MIT_TEXT,
      "src/ok.js": "a",
      "ee/feature.js": "b",
      "ee/LICENSE": AGPL_TEXT,
    });
    const clean = await checkLicense(source, proprietary, { maxFileBytes: MAX, paths: ["src/ok.js"] });
    expect(clean.verdict).toBe("allow_with_conditions");
    const report = await checkLicense(source, proprietary, { maxFileBytes: MAX, paths: ["ee/feature.js"] });
    expect(report.verdict).toBe("block");
    expect(report.file_overrides[0]).toMatchObject({
      path: "ee/feature.js",
      spdx: "AGPL-3.0",
      source: "nested_license",
    });
  });

  it("escalates on a stricter SPDX header", async () => {
    const source = repo({ LICENSE: MIT_TEXT, "src/x.js": "// SPDX-License-Identifier: GPL-3.0-only\nx();" });
    const report = await checkLicense(source, proprietary, { maxFileBytes: MAX, paths: ["src/x.js"] });
    expect(report.verdict).toBe("block");
  });

  it("prefers the license nearest a monorepo package", async () => {
    const source = repo({
      LICENSE: MIT_TEXT,
      "packages/pro/LICENSE": "Business Source License 1.1",
      "packages/pro/a.js": "x",
    });
    const report = await checkLicense(source, proprietary, { maxFileBytes: MAX, subdir: "packages/pro" });
    expect(report.source.spdx).toBe("BUSL-1.1");
  });
});
