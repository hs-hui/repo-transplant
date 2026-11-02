import { describe, expect, it, vi } from "vitest";
import { EvidenceInput, TransplantPlan } from "../src/session/schema.js";
import {
  assertLocalEnv,
  classifyRun,
  failingTests,
  runsInstallScripts,
  startServices,
  stopContainers,
  type VerifiedCommand,
} from "../src/session/verify.js";

const dockerCalls = vi.hoisted((): string[] => []);

// Docker may be absent, so its calls are recorded here. Readiness checks fail, as for a service that hangs.
vi.mock("../src/util/exec.js", async (original) => {
  const actual = await original<typeof import("../src/util/exec.js")>();
  return {
    ...actual,
    exec: async (file: string, args: string[], options: object) => {
      if (file !== "docker") return actual.exec(file, args, options);
      dockerCalls.push(args.join(" "));
      return { code: args[0] === "exec" ? 1 : 0, stdout: "", stderr: "", timedOut: false, durationMs: 0 };
    },
  };
});

const command = (over: Partial<VerifiedCommand> = {}): VerifiedCommand => ({
  name: "test",
  command: "npm test",
  kind: "test",
  timeout_s: 60,
  env: {},
  ...over,
});
const clean = { code: 0, timedOut: false };

describe("a run that tested nothing does not pass", () => {
  it.each([
    ["a Go filter that matched nothing", "ok  \texample.com/app/billing\t0.487s [no tests to run]\n"],
    ["Go test files with no test functions", "ok  \texample.com/app/feature\t0.1s [no tests to run]\n"],
    ["Go packages with no tests", "?   \texample.com/app/a\t[no test files]\n"],
    ["vitest with everything skipped", " Test Files  1 skipped (1)\n      Tests  2 skipped (2)\n"],
    ["vitest with skips and todos", "      Tests  2 skipped | 1 todo (3)\n"],
    ["Jest with everything skipped", "Tests:       5 skipped, 5 total\n"],
    ["pytest with everything skipped", "============ 3 skipped in 0.01s ============\n"],
    ["pytest with everything deselected", "===== 4 deselected in 0.02s =====\n"],
    ["node:test with everything skipped", "ℹ tests 2\nℹ pass 0\nℹ skipped 2\n"],
    ["cargo with everything ignored", "running 2 tests\ntest result: ok. 0 passed; 0 failed; 2 ignored\n"],
    ["output in colour", "\u001b[2m      Tests  \u001b[22m2 skipped (2)\n"],
    ["go -v with everything skipped", "=== RUN TestA\n--- SKIP: TestA (0.00s)\nPASS\nok  \tpkg\t0.1s\n"],
    ["unittest with everything skipped", "ss\nRan 2 tests in 0.001s\n\nOK (skipped=2)\n"],
  ])("%s", (_label, output) => {
    expect(classifyRun(command(), clean, output, false)).toBe("no_tests_ran");
  });

  it.each([
    ["a Go package that ran", "ok  \texample.com/app/a\t0.1s\n"],
    ["Go, one package ran and one matched nothing", "ok  \ta\t0.1s\nok  \tb\t0.1s [no tests to run]\n"],
    ["vitest with one pass beside skips", "      Tests  1 passed | 2 skipped (3)\n"],
    ["Jest with one pass beside skips", "Tests:       2 skipped, 1 passed, 3 total\n"],
    ["pytest with one pass", "===== 1 passed, 3 skipped in 0.01s =====\n"],
    ["node:test with a pass", "ℹ tests 2\nℹ pass 1\nℹ skipped 1\n"],
    ["unittest with a pass beside skips", "s.\nRan 2 tests in 0.001s\n\nOK (skipped=1)\n"],
    ["two node runs, one all skipped", "ℹ tests 1\nℹ pass 0\nℹ skipped 1\nℹ tests 1\nℹ pass 1\n"],
    [
      "go -v with a pass beside a skip",
      "--- SKIP: TestA (0.00s)\n--- PASS: TestB (0.00s)\nok  \tpkg\t0.1s\n",
    ],
    [
      "cargo with one target empty",
      "test result: ok. 0 passed; 0 failed\ntest result: ok. 4 passed; 0 failed\n",
    ],
  ])("still passes %s", (_label, output) => {
    expect(classifyRun(command(), clean, output, false)).toBe("passed");
  });

  it("does not apply to commands that are not tests", () => {
    expect(classifyRun(command({ kind: "build" }), clean, "Tests  2 skipped (2)\n", false)).toBe("passed");
  });
});

describe("Go failures carry their package", () => {
  const log = (pkg: string, name = "TestCreate"): string =>
    `--- FAIL: ${name} (0.00s)\n    x_test.go:5: boom\nFAIL\nFAIL\t${pkg}\t0.5s\n`;

  it("qualifies a name with the package that printed it", () => {
    expect(failingTests(`${log("example.com/app/auth")}${log("example.com/app/billing")}`)).toEqual([
      "example.com/app/auth/TestCreate",
      "example.com/app/billing/TestCreate",
    ]);
  });

  it("keeps the bare name when no package line follows", () => {
    expect(failingTests("--- FAIL: TestCreate (0.00s)\n")).toEqual(["TestCreate"]);
  });

  it("takes no failure name from what a passing test printed", () => {
    expect(failingTests("ERROR upstream timeout\n")).toEqual([]);
    expect(failingTests("ERROR tests/test_a.py - ImportError\n")).toEqual(["tests/test_a.py"]);
  });

  it("does not read a cached or subtest failure wrongly", () => {
    expect(failingTests("    --- FAIL: TestA/sub (0.00s)\nFAIL\tpkg\t(cached)\n")).toEqual(["pkg/TestA/sub"]);
  });
});

describe("install scripts", () => {
  it.each([
    "npm install",
    "npm i",
    "npm ci",
    "npm install left-pad",
    "pnpm install --frozen-lockfile",
    "corepack pnpm install",
    "yarn",
    "yarn --frozen-lockfile",
    "yarn install",
    "bun install",
    "cd web && npm ci",
    "npm install left-pad && npm ci --ignore-scripts",
    "npm ci --ignore-scripts=false",
    "npm --prefix web ci",
    "pnpm -C web install",
    "npm rebuild",
  ])("%s runs them", (text) => {
    expect(runsInstallScripts(text)).toBe(true);
  });

  it.each([
    "npm ci --ignore-scripts",
    "pnpm install --frozen-lockfile --ignore-scripts",
    "yarn install --ignore-scripts",
    "bun install --ignore-scripts",
    "npm test",
    "npm run build",
    "yarn test",
    "yarn build",
    "pip install -e .",
    "npm test -- --ignore-scripts",
  ])("%s does not", (text) => {
    expect(runsInstallScripts(text)).toBe(false);
  });
});

describe("commands stay local", () => {
  const check = (text: string, env: Record<string, string> = {}) =>
    assertLocalEnv(command({ command: text, env }));

  it.each([
    "DATABASE_URL=postgresql+psycopg2://app:pw@db.prod.example.com:5432/app alembic upgrade head",
    "alembic -x url=postgresql+asyncpg://app@db.prod.example.com/app upgrade head",
    "mysql+pymysql://app@db.prod.example.com/app",
    "mysql -hprod.db.example.com -uapp app",
    'psql "host=prod.db.example.com dbname=app"',
    "psql 'dbname=app host=prod.db.example.com'",
  ])("refuses %s", (text) => {
    expect(() => check(text)).toThrow(/connects to/);
  });

  it.each([
    "psql -hlocalhost -uapp app",
    'psql "host=localhost dbname=app"',
    "df -h",
    "du -hs .",
    "ls -hl",
    "go test -help",
  ])("allows %s", (text) => {
    expect(() => check(text)).not.toThrow();
  });

  it.each([
    "NODE_OPTIONS=--require ./hook.js node test.js",
    "set NODE_OPTIONS=--require ./hook.js&& node test.js",
    "export NODE_OPTIONS=--require",
    "env PATH=./bin npm test",
    "$env:NODE_OPTIONS='x'; node test.js",
    "cd x && LD_PRELOAD=./evil.so npm test",
  ])("refuses a forbidden variable in the text of %s", (text) => {
    expect(() => check(text)).toThrow(/cannot be set by a plan/);
  });

  it("allows settings that only tune output or caching", () => {
    expect(() => check("CARGO_TERM_COLOR=never cargo test")).not.toThrow();
    expect(() => check("UV_CACHE_DIR=x uv run pytest")).not.toThrow();
    expect(() => check("npm test", { PIP_NO_CACHE_DIR: "1" })).not.toThrow();
    expect(() => check("CARGO_BUILD_RUSTC_WRAPPER=./evil cargo test")).toThrow(/cannot be set/);
  });

  it("reads hosts the way each client takes them", () => {
    expect(() => check("sqlcmd -S prod.db.example.com -Q x")).toThrow(/connects to/);
    expect(() => check('psql -h "$PGHOST" app', { PGHOST: "localhost" })).not.toThrow();
  });

  it("allows ordinary inline variables", () => {
    expect(() => check("CI=1 FOO=bar npm test")).not.toThrow();
    expect(() => check('node -e "process.env.PATH=1"')).not.toThrow();
  });

  it("refuses an env key that smuggles an assignment", () => {
    const plan = {
      approach: "x",
      files: [{ path: "a", action: "create", purpose: "x" }],
      dependencies: {},
      verification: {
        commands: [{ name: "t", command: "npm test", kind: "test", env: { "NODE_OPTIONS=x": "" } }],
      },
      rollback: "x",
    };
    expect(TransplantPlan.safeParse(plan).success).toBe(false);
  });
});

describe("services and shutdown", () => {
  const service = { name: "db", image: "postgres:16", env: {}, ready_command: "pg_isready" };

  it("stops waiting for a service when the run is cancelled", async () => {
    dockerCalls.length = 0;
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 200);
    const started = Date.now();
    await expect(startServices([service], controller.signal)).rejects.toMatchObject({ code: "cancelled" });
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(dockerCalls.some((call) => call.startsWith("rm -f rt-service-"))).toBe(true);
    expect(dockerCalls.some((call) => call.startsWith("network rm rt-net-"))).toBe(true);
  });

  it("stops what is still running at shutdown", async () => {
    dockerCalls.length = 0;
    const controller = new AbortController();
    const pending = startServices([service], controller.signal).catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 100));
    await stopContainers();
    expect(dockerCalls.some((call) => call.startsWith("rm -f rt-service-"))).toBe(true);
    expect(dockerCalls.some((call) => call.startsWith("network rm rt-net-"))).toBe(true);
    controller.abort();
    await pending;
  });
});

describe("evidence fields", () => {
  it("takes a screenshot path", () => {
    expect(
      EvidenceInput.parse({
        acceptance_criterion: "AC-1",
        status: "pass",
        kind: "screenshot",
        screenshot_path: "shot.png",
        detail: "x",
      }).screenshot_path,
    ).toBe("shot.png");
  });
});
