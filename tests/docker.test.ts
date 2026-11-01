import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { fetchSnapshot, parseSource } from "../src/repo/fetch.js";
import {
  approvePlan,
  openWorkspace,
  recordPlan,
  recordSpec,
  startSession,
  traceSession,
  verifySession,
} from "../src/session/workflow.js";
import { createRepo, MIT_TEXT, testConfig, writeFiles } from "./helpers.js";

// Needs a running daemon and pulls an image, so it only runs when asked: RT_DOCKER_TEST=1.
const IMAGE = "node:24-slim";

const SOURCE = {
  LICENSE: MIT_TEXT,
  "package.json": '{"license":"MIT"}',
  "src/score.js": "exports.score = (text) => text.length;\n",
};

const SPEC = {
  name: "Scoring",
  summary: "Scores text.",
  in_scope: ["Score"],
  behaviors: ["Length"],
  acceptance_criteria: [
    { id: "AC-1", given: "text", when: "scored", then: "returns length", verification: "unit" },
  ],
};

const IMPLEMENTATION = {
  "src/score.js": "exports.score = (text) => text.length;\n",
  "tests/score.test.js": `const { test } = require('node:test');
const assert = require('node:assert');
const { score } = require('../src/score.js');
test('returns the length', () => assert.equal(score('abc'), 3));
`,
};

const REACH_REGISTRY =
  "node -e \"require('https').get('https://registry.npmjs.org',()=>process.exit(0)).on('error',()=>process.exit(1))\"";

async function startInDocker(commands: Record<string, unknown>[], services: Record<string, unknown>[] = []) {
  const config = testConfig();
  const snapshot = await fetchSnapshot(parseSource(createRepo(SOURCE), config, true), config);
  const target = createRepo({
    "package.json": '{"name":"t","private":true,"dependencies":{"is-number":"7.0.0"}}',
  });
  const started = await startSession(config, {
    snapshot_id: snapshot.id,
    target_path: target,
    feature: "Scoring",
  });
  await traceSession(config, started.id, { seeds: ["src/score.js"] });
  await recordSpec(config, started.id, SPEC);
  const planned = await recordPlan(config, started.id, {
    approach: "Port it.",
    files: [
      {
        path: "src/score.js",
        action: "create",
        purpose: "Score",
        source_refs: ["src/score.js"],
        acceptance_criteria: ["AC-1"],
      },
      { path: "tests/score.test.js", action: "create", purpose: "Test", acceptance_criteria: ["AC-1"] },
    ],
    dependencies: { add: [] },
    verification: { docker_image: IMAGE, commands, services },
    rollback: "Delete the branch.",
  });
  await approvePlan(config, started.id, {
    plan_hash: planned.planHash!,
    user_confirmation: "yes",
    via: "agent_attested",
  });
  const session = await openWorkspace(config, started.id);
  writeFiles(session.workspace!.path, IMPLEMENTATION);
  return { config, id: started.id, workspace: session.workspace! };
}

async function runInDocker(commands: Record<string, unknown>[], services: Record<string, unknown>[] = []) {
  const { config, id } = await startInDocker(commands, services);
  return (await verifySession(config, id, { continueOnFailure: true })).results;
}

describe.skipIf(!process.env.RT_DOCKER_TEST)("verification in a live Docker daemon", () => {
  it("installs with network, then tests without it", { timeout: 300_000 }, async () => {
    const results = await runInDocker([
      { name: "install", command: "npm install --ignore-scripts", kind: "install" },
      { name: "unit", command: "node --test --test-reporter=spec", kind: "test" },
      { name: "offline", command: REACH_REGISTRY, kind: "lint" },
      { name: "no-repo", command: "test ! -e .git", kind: "lint" },
    ]);
    const statuses = Object.fromEntries(results.map((item) => [item.name, item.status]));
    expect(results[0]?.isolation).toBe("docker");
    expect(statuses).toEqual({ install: "passed", unit: "passed", offline: "failed", "no-repo": "passed" });
    expect(readFileSync(results[1]!.log_path, "utf8")).toContain("returns the length");
  });

  it("reaches a database by name, but not the internet", { timeout: 300_000 }, async () => {
    const connect =
      "require('net').connect(5432,'db').on('connect',()=>process.exit(0)).on('error',()=>process.exit(1))";
    const results = await runInDocker(
      [
        { name: "unit", command: "node --test --test-reporter=spec", kind: "test" },
        { name: "database", command: `node -e "${connect}"`, kind: "lint" },
        { name: "offline", command: REACH_REGISTRY, kind: "lint" },
      ],
      [
        {
          name: "db",
          image: "postgres:16-alpine",
          env: { POSTGRES_PASSWORD: "local-only" },
          ready_command: "pg_isready -U postgres",
        },
      ],
    );
    const statuses = Object.fromEntries(results.map((item) => [item.name, item.status]));
    expect(statuses).toEqual({ unit: "passed", database: "passed", offline: "failed" });
    const left = (args: string[]) => execFileSync("docker", args).toString().trim();
    expect(left(["ps", "-a", "--filter", "name=rt-service-", "--format", "{{.Names}}"])).toBe("");
    expect(left(["network", "ls", "--filter", "name=rt-net-", "--format", "{{.Name}}"])).toBe("");
  });

  it("can check changed code again after a run as root", { timeout: 300_000 }, async () => {
    const { config, id, workspace } = await startInDocker([
      { name: "install", command: "npm install --ignore-scripts", kind: "install" },
      { name: "unit", command: "node --test --test-reporter=spec", kind: "test" },
    ]);
    await verifySession(config, id, {});
    writeFiles(workspace.path, { "src/score.js": "exports.score = (text) => text.length; // v2\n" });
    const { results } = await verifySession(config, id, {});
    expect(results.map((item) => item.status)).toEqual(["passed", "passed"]);
  });

  it("keeps what install fetched for the offline commands after it", { timeout: 120_000 }, async () => {
    const results = await runInDocker([
      { name: "install", command: 'echo fetched > "$HOME/cache-marker"', kind: "install" },
      { name: "read", command: 'test "$(cat "$HOME/cache-marker")" = fetched', kind: "lint" },
      { name: "unit", command: "node --test --test-reporter=spec", kind: "test" },
    ]);
    expect(results.map((item) => item.status)).toEqual(["passed", "passed", "passed"]);
  });

  it("stops a container that runs past its timeout", { timeout: 120_000 }, async () => {
    const [result] = await runInDocker([{ name: "stuck", command: "sleep 60", kind: "test", timeout_s: 3 }]);
    expect(result?.status).toBe("timed_out");
    const running = execFileSync("docker", ["ps", "--filter", "name=rt-verify-", "--format", "{{.Names}}"]);
    expect(running.toString().trim()).toBe("");
  });

  it("does not trust a command that rewrites reviewed files", { timeout: 120_000 }, async () => {
    const [result] = await runInDocker([
      { name: "rewrite", command: "echo changed >> src/score.js", kind: "lint" },
      { name: "unit", command: "node --test --test-reporter=spec", kind: "test" },
    ]);
    expect(result?.status).toBe("modified_files");
  });
});
