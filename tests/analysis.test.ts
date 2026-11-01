import { describe, expect, it } from "vitest";
import { scanBackend } from "../src/analysis/backend.js";
import { assessFeasibility } from "../src/analysis/feasibility.js";
import { buildGraph } from "../src/analysis/graph.js";
import { extractImports } from "../src/analysis/imports.js";
import { checkLicense } from "../src/analysis/license.js";
import { parseManifest } from "../src/analysis/manifests.js";
import { profileRepo } from "../src/analysis/profile.js";
import { expandQuery, searchFeature, tokenize } from "../src/analysis/search.js";
import { scanRepository } from "../src/analysis/security.js";
import { compareStacks } from "../src/analysis/stack.js";
import { traceFeature } from "../src/analysis/trace.js";
import { classifyFile } from "../src/repo/walk.js";
import { MIT_TEXT, tempDir, writeFiles } from "./helpers.js";

const MAX = 1_000_000;

async function graphOf(files: Record<string, string>) {
  const root = tempDir();
  writeFiles(root, files);
  return buildGraph(root, MAX, { useCache: false });
}

const edges = (graph: Awaited<ReturnType<typeof graphOf>>, rel: string): string[] =>
  [...graph.nodes.get(rel)!.internal].sort();

describe("import extraction", () => {
  const specs = (rel: string, text: string): string[] =>
    extractImports(rel, text)
      .map((item) => item.specifier)
      .sort();

  it("parses every JS and TS import form", () => {
    expect(
      specs(
        "a.tsx",
        `import a from "./a"; import type { B } from "./b"; export * from "./c"; export { d } from "./d";
         const e = await import("./e"); const f = require("./f"); import g = require("./g");
         const h = <T,>(x: T) => <div>{x}</div>;`,
      ),
    ).toEqual(["./a", "./b", "./c", "./d", "./e", "./f", "./g"]);
  });

  it("ignores imports inside strings and comments", () => {
    expect(specs("a.ts", `// import x from "./no"\nconst s = 'import y from "./no2"';`)).toEqual([]);
  });

  it("keeps generics working in .ts files", () => {
    expect(specs("a.ts", `import a from "./a";\nconst f = <T>(x: T) => x;`)).toEqual(["./a"]);
  });

  it("falls back on regex when parsing fails", () => {
    expect(specs("a.js", `import a from "./a";\nthis is not valid javascript }{`)).toContain("./a");
  });

  it("reads Vue and Svelte script blocks", () => {
    expect(
      specs(
        "A.vue",
        `<template><div/></template>\n<script setup lang="ts">\nimport x from "./x";\n</script>`,
      ),
    ).toEqual(["./x"]);
    expect(specs("A.svelte", `<script>\nimport y from "./y";\n</script>\n<div/>`)).toEqual(["./y"]);
  });

  it("parses Python multi-line imports", () => {
    expect(specs("a.py", "from .models import (\n  User,\n  Item,\n)\nimport os, json as j\n")).toEqual([
      ".models",
      ".models.Item",
      ".models.User",
      "json",
      "os",
    ]);
  });

  it("parses Go, Rust, Ruby, PHP, Java and CSS", () => {
    expect(specs("a.go", 'import (\n  "fmt"\n  x "example.com/m/pkg"\n)\n')).toEqual([
      "example.com/m/pkg",
      "fmt",
    ]);
    expect(specs("a.rs", "use crate::db::conn;\nmod helpers;\nuse serde::Serialize;\n")).toEqual([
      "crate::db::conn",
      "mod:helpers",
      "serde::Serialize",
    ]);
    expect(specs("a.rb", "require_relative 'x'\nrequire 'json'\n")).toEqual(["./x", "json"]);
    expect(specs("a.php", "use App\\Models\\User;\nrequire_once 'lib/x.php';\n")).toEqual([
      "./lib/x.php",
      "App\\Models\\User",
    ]);
    expect(specs("A.java", "import com.acme.Foo;\nimport static com.acme.Bar.baz;\n")).toEqual([
      "com.acme.Bar.baz",
      "com.acme.Foo",
    ]);
    expect(specs("a.css", '@import "./b.css";\n.a { background: url("./c.png"); }\n')).toEqual([
      "./b.css",
      "./c.png",
    ]);
  });
});

describe("dependency graph", () => {
  it("resolves JS relative paths, indexes and .js-to-.ts", async () => {
    const graph = await graphOf({
      "src/a.ts": `import "./b.js"; import "./dir"; import "./c";`,
      "src/b.ts": "",
      "src/dir/index.ts": "",
      "src/c.tsx": "",
    });
    expect(edges(graph, "src/a.ts")).toEqual(["src/b.ts", "src/c.tsx", "src/dir/index.ts"]);
  });

  it("resolves tsconfig aliases including comments", async () => {
    const graph = await graphOf({
      "tsconfig.json": `{ // aliases\n "compilerOptions": { "baseUrl": ".", "paths": { "@lib/*": ["src/lib/*"] } } }`,
      "src/a.ts": `import "@lib/x"; import "react"; import "node:fs"; import "path";`,
      "src/lib/x.ts": "",
    });
    expect(edges(graph, "src/a.ts")).toEqual(["src/lib/x.ts"]);
    expect([...graph.nodes.get("src/a.ts")!.external]).toEqual(["react"]);
  });

  it("keeps scoped package names and resolves the conventional @/ alias", async () => {
    const graph = await graphOf({ "src/a.ts": `import "@/b"; import "@scope/pkg/sub";`, "src/b.ts": "" });
    expect(edges(graph, "src/a.ts")).toEqual(["src/b.ts"]);
    expect([...graph.nodes.get("src/a.ts")!.external]).toEqual(["@scope/pkg"]);
  });

  it("links workspace packages as internal files", async () => {
    const graph = await graphOf({
      "packages/ui/package.json": '{"name":"@acme/ui"}',
      "packages/ui/src/index.ts": "",
      "apps/web/a.ts": `import "@acme/ui";`,
    });
    expect(edges(graph, "apps/web/a.ts")).toEqual(["packages/ui/src/index.ts"]);
  });

  it("resolves Python packages, relative imports and submodules", async () => {
    const graph = await graphOf({
      "app/__init__.py": "",
      "app/api/__init__.py": "",
      "app/api/routes.py":
        "from ..core import config\nfrom app.models import User\nimport requests\nimport os\n",
      "app/core/__init__.py": "",
      "app/core/config.py": "",
      "app/models.py": "",
    });
    expect(edges(graph, "app/api/routes.py")).toEqual([
      "app/core/__init__.py",
      "app/core/config.py",
      "app/models.py",
    ]);
    expect([...graph.nodes.get("app/api/routes.py")!.external]).toEqual(["requests"]);
  });

  it("resolves Go packages to their files, skipping tests", async () => {
    const graph = await graphOf({
      "go.mod": "module example.com/app\n",
      "main.go":
        'package main\nimport (\n "fmt"\n "example.com/app/internal/db"\n "github.com/gin-gonic/gin"\n)\n',
      "internal/db/db.go": "package db\n",
      "internal/db/db_test.go": "package db\n",
    });
    expect(edges(graph, "main.go")).toEqual(["internal/db/db.go"]);
    expect([...graph.nodes.get("main.go")!.external]).toEqual(["github.com/gin-gonic/gin"]);
  });

  it("resolves Rust modules", async () => {
    const graph = await graphOf({
      "src/main.rs": "mod db;\nuse crate::db::conn;\nuse serde::Serialize;\nuse std::fs;\n",
      "src/db/mod.rs": "pub mod conn;\n",
      "src/db/conn.rs": "",
    });
    expect(edges(graph, "src/main.rs")).toEqual(["src/db/conn.rs", "src/db/mod.rs"]);
    expect([...graph.nodes.get("src/main.rs")!.external]).toEqual(["serde"]);
  });

  it("resolves PHP psr-4 and Java packages", async () => {
    const graph = await graphOf({
      "composer.json": '{"autoload":{"psr-4":{"Acme\\\\":"src/"}}}',
      "src/Http/Ctl.php": "<?php\nuse Acme\\Models\\User;\nuse Monolog\\Logger;\n",
      "src/Models/User.php": "<?php\n",
      "src/main/java/com/acme/A.java": "import com.acme.B;\nimport java.util.List;\n",
      "src/main/java/com/acme/B.java": "",
    });
    expect(edges(graph, "src/Http/Ctl.php")).toEqual(["src/Models/User.php"]);
    expect(edges(graph, "src/main/java/com/acme/A.java")).toEqual(["src/main/java/com/acme/B.java"]);
  });
});

describe("feature tracing", () => {
  const app: Record<string, string> = Object.fromEntries(
    Array.from({ length: 12 }, (_, index) => [`src/page${index}.ts`, `import "./lib/log";`]),
  );

  it("follows the closure and stops at widely shared modules", async () => {
    const graph = await graphOf({
      ...app,
      "src/lib/log.ts": "",
      "src/cart/index.ts": `import "./store"; import "../lib/log"; import "stripe"; import "./cart.css";`,
      "src/cart/store.ts": `import "./helpers"; import "zustand";`,
      "src/cart/helpers.ts": "",
      "src/cart/cart.css": `.a { background: url("./bg.png"); }`,
      "src/cart/bg.png": "x",
      "src/cart/store.test.ts": `import "./store";`,
      "src/shop.ts": `import "./cart";`,
    });
    const trace = traceFeature(graph, { seeds: ["src/cart/index.ts"] });
    expect(trace.files.map((file) => file.path).sort()).toEqual([
      "src/cart/bg.png",
      "src/cart/cart.css",
      "src/cart/helpers.ts",
      "src/cart/index.ts",
      "src/cart/store.ts",
    ]);
    expect(trace.shared_infrastructure.map((item) => item.path)).toEqual(["src/lib/log.ts"]);
    expect(trace.external_packages).toEqual(["stripe", "zustand"]);
    expect(trace.tests).toEqual(["src/cart/store.test.ts"]);
    expect(trace.assets).toEqual(["src/cart/bg.png"]);
    expect(trace.integration_points.map((item) => item.path)).toEqual(["src/shop.ts"]);
  });

  it("does not call a feature's core shared just because tests import it", async () => {
    const tests = Object.fromEntries(
      Array.from({ length: 12 }, (_, i) => [`test/t${i}.test.ts`, `import "../src/core";`]),
    );
    const graph = await graphOf({ ...tests, "src/core.ts": "", "src/ui.ts": `import "./core";` });
    const trace = traceFeature(graph, { seeds: ["src/ui.ts"] });
    expect(trace.files.map((file) => file.path)).toContain("src/core.ts");
    expect(trace.shared_infrastructure).toEqual([]);
  });

  it("links schema models the closure uses, even though nothing imports them", async () => {
    const graph = await graphOf({
      "prisma/schema.prisma": "model Comment {\n  id Int\n}\nmodel Invoice {\n  id Int\n}\n",
      "prisma/migrations/001/migration.sql": 'CREATE TABLE "Comment" (id int);',
      "src/service.ts": "export const list = () => prisma.comment.findMany();",
      "src/other.ts": "export const x = 1;",
    });
    const used = traceFeature(graph, { seeds: ["src/service.ts"] }).backend;
    expect(new Set(used.data.map((item) => item.name))).toEqual(new Set(["Comment"]));
    expect(used.migrations).toEqual(["prisma/migrations/001/migration.sql"]);
    expect(used.has_backend).toBe(true);
    const unrelated = traceFeature(graph, { seeds: ["src/other.ts"] }).backend;
    expect(unrelated.data).toEqual([]);
    expect(unrelated.has_backend).toBe(false);
  });

  it("expands directories, applies excludes, and reports limits", async () => {
    const graph = await graphOf({
      "f/a.ts": `import "./b"; import "./c";`,
      "f/b.ts": `import "./d";`,
      "f/c.ts": "",
      "f/d.ts": "",
    });
    expect(traceFeature(graph, { seeds: ["f"], maxFiles: 2 }).files.length).toBe(4);
    const excluded = traceFeature(graph, { seeds: ["f/a.ts"], exclude: ["f/c.ts"] });
    expect(excluded.excluded).toEqual(["f/c.ts"]);
    const shallow = traceFeature(graph, { seeds: ["f/a.ts"], maxDepth: 1 });
    expect(shallow.truncated).toBe(true);
    expect(() => traceFeature(graph, { seeds: ["missing.ts"] })).toThrow(/Seed not found/);
    expect(() => traceFeature(graph, { seeds: ["../etc"] })).toThrow(/inside the repository/);
  });
});

describe("feature search", () => {
  it("splits identifiers", () => {
    expect(tokenize("CommandPalette user_name HTTPServer")).toEqual([
      "command",
      "palette",
      "user",
      "name",
      "http",
      "server",
    ]);
  });

  it("expands Korean feature words", () => {
    const terms = expandQuery("로그인 기능 추가해줘").map((item) => item.term);
    expect(terms).toEqual(expect.arrayContaining(["login", "signin", "auth"]));
    expect(terms).not.toContain("기능");
  });

  it("ranks path and declaration matches first and finds features from Korean", async () => {
    const graph = await graphOf({
      "src/payments/checkout.ts": "export function createCheckoutSession() { return stripe.checkout; }",
      "src/payments/webhook.ts": "export function handleStripeWebhook() {}",
      "src/utils/format.ts": "// mentions payment once\nexport const f = 1;",
      "src/payments/checkout.test.ts": "createCheckoutSession",
      "README.md": "payment payment payment",
    });
    const result = searchFeature(graph, "결제");
    expect(result.hits[0]?.path).toMatch(/^src\/payments\//);
    expect(result.hits.map((hit) => hit.path)).not.toContain("src/payments/checkout.test.ts");
    expect(result.hits.map((hit) => hit.path)).not.toContain("README.md");
    expect(result.clusters[0]?.directory).toBe("src/payments");
    expect(result.suggested_seeds).toContain("src/payments/checkout.ts");
  });
});

describe("backend surface", () => {
  it("finds routes across frameworks with per-route auth hints", async () => {
    const graph = await graphOf({
      "src/express.ts": `router.get('/public', async (req, res) => {});\n\n\n\n\n\n\n\nrouter.post('/private', auth.required, async () => {});`,
      "src/nest.ts": `@Controller('users')\nclass C {\n  @UseGuards(JwtGuard)\n  @Get(':id')\n  find() {}\n}`,
      "app/api/items/route.ts": `export async function GET() {}\nexport const POST = () => getServerSession();`,
      "pages/api/ping.ts": "export default function handler() {}",
      "app/main.py": `router = APIRouter(prefix="/items")\n@router.get("/{id}")\ndef read(current_user: CurrentUser): pass`,
      "proj/urls.py": `urlpatterns = [path("api/users/", view)]`,
      "main.go": `r.GET("/health", h)\nmux.HandleFunc("/x", h)`,
      "config/routes.rb": `get '/profile', to: 'x#y'\nresources :posts`,
      "routes/api.php": `Route::post('/orders', [C::class, 'store']);`,
      "src/A.java": `@GetMapping("/books")\npublic List<Book> all() {}`,
      "src/main.rs": `#[get("/a")]\nasync fn a() {}\nlet r = Router::new().route("/b", post(b));`,
      "src/P.cs": `app.MapGet("/c", () => 1);`,
    });
    const surface = scanBackend(graph);
    const found = surface.routes.map((route) => `${route.method} ${route.path}`);
    expect(found).toEqual(
      expect.arrayContaining([
        "GET /public",
        "POST /private",
        "GET /users/:id",
        "GET /items/{id}",
        "POST /api/items",
        "GET /api/items",
        "ANY /api/ping",
        "ANY api/users/",
        "GET /health",
        "ANY /x",
        "GET /profile",
        "POST /orders",
        "GET /books",
        "GET /a",
        "POST /b",
        "GET /c",
      ]),
    );
    const byPath = new Map(surface.routes.map((route) => [route.path, route]));
    expect(byPath.get("/public")?.auth_hint).toBeNull();
    expect(byPath.get("/private")?.auth_hint).toBe("auth.required");
    expect(byPath.get("/users/:id")?.auth_hint).toBe("@UseGuards");
    expect(byPath.get("/items/{id}")?.auth_hint).toBe("current_user");
  });

  it("finds data models, migrations, env, jobs, realtime and services", async () => {
    const graph = await graphOf({
      "prisma/schema.prisma": "model User {\n  id Int\n}\nmodel Post {\n  id Int\n}",
      "prisma/migrations/001_init/migration.sql": "CREATE TABLE users (id int);",
      "db/schema.ts": `export const items = pgTable('items', {});`,
      "app/models.py": "class Item(models.Model):\n    pass\n\nclass Row(Base):\n    __tablename__ = 'r'",
      "app/config.py": "class Settings(BaseSettings):\n    SMTP_PASSWORD: str\n    API_URL: str = ''\n",
      "src/mail.ts": `import { Resend } from "resend";\nconst key = process.env.RESEND_API_KEY; const m = process.env['MAIL_FROM'];`,
      "src/queue.ts": `const q = new Queue('emails');\ncron.schedule('* * * * *', f);`,
      "src/ws.ts": `const wss = new WebSocketServer({ port: 1 });`,
      "src/stream.ts": `res.setHeader('Content-Type', 'text/event-stream');`,
      ".env.example": "STRIPE_SECRET_KEY=\nPUBLIC_URL=http://localhost\n",
      "src/middleware/auth.ts": "export const x = 1;",
    });
    const surface = scanBackend(graph);
    expect(surface.has_backend).toBe(true);
    expect(surface.data.map((item) => item.name)).toEqual(
      expect.arrayContaining(["User", "Post", "items", "Item", "Row"]),
    );
    expect(surface.migrations).toEqual(["prisma/migrations/001_init/migration.sql"]);
    expect(surface.env_vars.map((item) => item.name)).toEqual(
      expect.arrayContaining([
        "RESEND_API_KEY",
        "MAIL_FROM",
        "SMTP_PASSWORD",
        "API_URL",
        "STRIPE_SECRET_KEY",
        "PUBLIC_URL",
      ]),
    );
    const env = new Map(surface.env_vars.map((item) => [item.name, item]));
    expect(env.get("RESEND_API_KEY")?.likely_secret).toBe(true);
    expect(env.get("MAIL_FROM")?.likely_secret).toBe(false);
    expect(surface.jobs.map((item) => item.kind)).toEqual(["bullmq", "cron"]);
    expect(surface.realtime.map((item) => item.kind)).toEqual(expect.arrayContaining(["ws", "sse"]));
    expect(surface.external_services[0]).toMatchObject({ service: "Resend", package: "resend" });
    expect(surface.middleware).toEqual(["src/middleware/auth.ts"]);
    expect(surface.auth_files).toContain("src/middleware/auth.ts");
  });

  it("reports nothing for a frontend-only feature", async () => {
    const graph = await graphOf({ "src/Button.tsx": "export const B = () => <button/>;" });
    expect(scanBackend(graph).has_backend).toBe(false);
  });
});

describe("manifests", () => {
  it("parses each ecosystem", () => {
    const names = (rel: string, text: string): string[] =>
      parseManifest(rel, text).map((dep) => `${dep.name}@${dep.version}`);
    expect(names("package.json", '{"dependencies":{"a":"^1"},"devDependencies":{"b":"2"}}')).toEqual([
      "a@^1",
      "b@2",
    ]);
    expect(
      names(
        "requirements.txt",
        "fastapi==0.1\n# c\n-r base.txt\nUvicorn[standard]>=0.2 ; python_version>'3'\n",
      ),
    ).toEqual(["fastapi@==0.1", "uvicorn@>=0.2"]);
    expect(
      names(
        "pyproject.toml",
        '[project]\nname="x"\ndependencies = [\n  "httpx>=0.2",\n  "pydantic[email]",\n]\n',
      ),
    ).toEqual(["httpx@>=0.2", "pydantic@*"]);
    expect(
      names(
        "pyproject.toml",
        '[tool.poetry.dependencies]\npython = "^3.11"\nflask = "^3"\nx = {version = "1"}\n',
      ),
    ).toEqual(["flask@^3", "x@1"]);
    expect(
      names(
        "go.mod",
        "module m\nrequire (\n\tgithub.com/a/b v1.2.3\n\tgithub.com/c/d v0.1.0 // indirect\n)\nrequire example.com/e v2.0.0\n",
      ),
    ).toEqual(["github.com/a/b@v1.2.3", "example.com/e@v2.0.0"]);
    expect(
      names(
        "Cargo.toml",
        '[dependencies]\nserde = { version = "1", features = ["derive"] }\ntokio = "1.2"\n',
      ),
    ).toEqual(["serde@1", "tokio@1.2"]);
    expect(names("Gemfile", "gem 'rails', '~> 7.0'\ngem \"puma\"\n")).toEqual(["rails@~> 7.0", "puma@*"]);
    expect(names("composer.json", '{"require":{"php":">=8","laravel/framework":"^11"}}')).toEqual([
      "laravel/framework@^11",
    ]);
    expect(
      names(
        "pom.xml",
        "<dependency><groupId>g</groupId><artifactId>a</artifactId><version>1</version></dependency>",
      ),
    ).toEqual(["g:a@1"]);
    expect(names("build.gradle", "implementation 'g:a:1'\n")).toEqual(["g:a@1"]);
    expect(names("a.csproj", '<PackageReference Include="Serilog" Version="3" />')).toEqual(["Serilog@3"]);
  });
});

describe("file classification", () => {
  it.each([
    ["src/a.test.ts", "test"],
    ["tests/x.py", "test"],
    ["test_a.py", "test"],
    ["a_test.go", "test"],
    ["src/a.ts", "source"],
    ["package-lock.json", "lock"],
    ["a.min.js", "generated"],
    ["src/generated/x.ts", "generated"],
    ["a.png", "asset"],
    ["a.scss", "style"],
    ["README.md", "doc"],
    ["vite.config.ts", "config"],
  ])("%s is %s", (rel, expected) => {
    expect(classifyFile(rel)).toBe(expected);
  });
});

describe("profiling, stack comparison and feasibility", () => {
  async function project(files: Record<string, string>) {
    const root = tempDir();
    writeFiles(root, files);
    return { root, profile: await profileRepo(root, MAX) };
  }

  it("detects stack, conventions, design tokens and commands", async () => {
    const { profile } = await project({
      "package.json": JSON.stringify({
        scripts: { test: "vitest run", lint: "eslint .", build: "next build", typecheck: "tsc" },
        dependencies: { react: "^19.0.0", next: "^15.0.0", zustand: "^5.0.0", "@prisma/client": "^6.0.0" },
        devDependencies: { tailwindcss: "^4.0.0", vitest: "^3.0.0", typescript: "^5.0.0" },
      }),
      "pnpm-lock.yaml": "",
      "tailwind.config.ts": "export default {}",
      "components.json": "{}",
      "tsconfig.json": '{"compilerOptions":{"paths":{"@/*":["./src/*"]}}}',
      "src/app/globals.css": ":root { --background: #fff; --primary: #000; }",
      "src/components/ui/button.tsx": "export const Button = () => null;\n",
      "src/app/page.tsx": `'use client'\nexport default function Page() {\n  const a = 'x'\n  return null\n}\n`,
      "src/lib/use-thing.ts": `export const thing = 'a'\nexport function run() {\n  return 'b'\n}\n`,
      "prisma/schema.prisma": "model A { id Int }",
      "src/lib/use-thing.test.ts": "",
    });
    expect(profile.stack).toMatchObject({
      ui_framework: ["react"],
      meta_framework: ["next"],
      state: ["zustand"],
      orm: ["prisma"],
      styling: ["tailwind"],
      ui_kit: ["shadcn-ui"],
    });
    expect(profile.packageManager).toBe("pnpm");
    expect(profile.conventions).toMatchObject({
      indent: "2 spaces",
      quotes: "single",
      semicolons: false,
      testLayout: "colocated",
    });
    expect(profile.conventions.pathAliases).toHaveProperty("@/*");
    expect(profile.conventions.architecture).toContain("ui_primitives_dir");
    expect(profile.design_system.cssVariables).toEqual(expect.arrayContaining(["--background", "--primary"]));
    expect(profile.design_system.uiComponents).toEqual(["src/components/ui/button.tsx"]);
    expect(profile.has_backend).toBe(true);
    expect(profile.suggested_commands.map((item) => item.command)).toEqual([
      "pnpm install --frozen-lockfile --ignore-scripts",
      "pnpm typecheck",
      "pnpm lint",
      "pnpm test",
      "pnpm build",
    ]);
  });

  it("never suggests an install command that runs lifecycle scripts", async () => {
    for (const lock of ["package-lock.json", "yarn.lock", "bun.lockb", "pnpm-lock.yaml"]) {
      const { profile } = await project({ "package.json": "{}", [lock]: "" });
      expect(profile.suggested_commands[0]?.command).toContain("--ignore-scripts");
    }
  });

  it("installs Python packages before running checks, wheels only", async () => {
    const { profile } = await project({
      "pyproject.toml": "[project]\nname = 'a'\n",
      "requirements.txt": "flask==3.1.1\n",
      "requirements-dev.txt": "-r requirements.txt\npytest==8.3.5\n",
    });
    const [install, test] = profile.suggested_commands;
    expect(install).toMatchObject({ kind: "install" });
    expect(install!.command).toContain("python -m venv .venv");
    expect(install!.command).toContain("--only-binary=:all: -r requirements-dev.txt");
    expect(test!.command).toMatch(/\.venv[\\/](Scripts|bin)[\\/]python -m pytest -q/);
  });

  it("uses the Python project's own lockfile tool when it has one", async () => {
    const { profile } = await project({
      "pyproject.toml": "[project]\nname = 'a'\ndependencies = ['pytest']\n",
      "uv.lock": "",
    });
    expect(profile.suggested_commands.map((item) => item.command)).toEqual([
      "uv sync --frozen",
      "uv run python -m pytest -q",
    ]);
  });

  it("offers a container and services that match the project", async () => {
    const { profile } = await project({
      "go.mod": "module x\n\ngo 1.24\n\nrequire github.com/lib/pq v1.10.0\n",
      "docker-compose.yml": "services:\n  cache:\n    image: redis:7\n  db:\n    image: 'postgres:16'\n",
    });
    expect(profile.suggested_docker_image).toBe("golang:1.24");
    expect(profile.suggested_services.map((item) => item.name)).toEqual(["db", "redis"]);
    expect(profile.suggested_services[0]?.ready_command).toContain("pg_isready");
  });

  it("offers nothing for a project with no database", async () => {
    const { profile } = await project({ "package.json": "{}", ".nvmrc": "v22.1.0\n" });
    expect(profile.suggested_services).toEqual([]);
    expect(profile.suggested_docker_image).toBe("node:22");
  });

  it("offers an image with the tool the project's lockfile needs", async () => {
    const uv = await project({ "pyproject.toml": '[project]\nrequires-python = ">=3.13"\n', "uv.lock": "" });
    expect(uv.profile.suggested_docker_image).toBe("ghcr.io/astral-sh/uv:python3.13-bookworm-slim");
    const maven = await project({ "pom.xml": "<project><java.version>25</java.version></project>" });
    expect(maven.profile.suggested_docker_image).toBe("maven:3.9-eclipse-temurin-25");
  });

  it("reads the Python version a project asks for", async () => {
    const { profile } = await project({ "pyproject.toml": '[project]\nrequires-python = ">=3.14,<4"\n' });
    expect(profile.suggested_docker_image).toBe("python:3.14-slim");
  });

  it("decides reuse, equivalents, additions and conflicts", async () => {
    const source = await project({
      "package.json": JSON.stringify({
        dependencies: {
          react: "^18.0.0",
          zustand: "^4.0.0",
          axios: "^1.0.0",
          dayjs: "^1.0.0",
          "fuse.js": "^7.0.0",
        },
      }),
    });
    const target = await project({
      "package.json": JSON.stringify({
        dependencies: { react: "^19.0.0", "@reduxjs/toolkit": "^2.0.0", ky: "^1.0.0", dayjs: "^1.11.0" },
      }),
    });
    const result = compareStacks(source.profile, target.profile);
    const action = new Map(result.dependency_decisions.map((item) => [item.package, item.action]));
    expect(Object.fromEntries(action)).toEqual({
      react: "version_conflict",
      zustand: "reuse_equivalent",
      axios: "reuse_equivalent",
      dayjs: "reuse_installed",
      "fuse.js": "add",
    });
    expect(result.differences.find((row) => row.category === "state")).toMatchObject({ status: "different" });
    expect(result.cross_framework).toBe(false);
  });

  it("flags cross-framework and cross-language moves", async () => {
    const react = await project({
      "package.json": '{"dependencies":{"react":"^19.0.0"}}',
      "a.tsx": "x".repeat(100),
    });
    const vue = await project({
      "package.json": '{"dependencies":{"vue":"^3.0.0"}}',
      "a.vue": "x".repeat(100),
    });
    const go = await project({ "go.mod": "module m\n", "a.go": "x".repeat(100) });
    expect(compareStacks(react.profile, vue.profile).cross_framework).toBe(true);
    expect(compareStacks(react.profile, go.profile).cross_language).toBe(true);
  });

  it("explains its score and stops on blockers", async () => {
    const root = tempDir();
    writeFiles(root, {
      "src/pay.ts": `import Stripe from "stripe";\nrouter.post('/pay', async () => { process.env.STRIPE_SECRET_KEY; });\nmodel('Order', s);`,
      "migrations/001.sql": "CREATE TABLE orders (id int);",
    });
    const graph = await buildGraph(root, MAX, { useCache: false });
    const trace = traceFeature(graph, { seeds: ["src", "migrations/001.sql"].slice(0, 1) });
    const source = await profileRepo(root, MAX);
    const target = await project({ "package.json": "{}" });
    const blocked = assessFeasibility(
      trace,
      compareStacks(source, target.profile, trace.external_packages),
      await checkLicense(root, target.root, { maxFileBytes: MAX }),
      await scanRepository(root, { maxFileBytes: MAX }),
    );
    expect(blocked.go).toBe(false);
    expect(blocked.blockers[0]).toContain("License");
    expect(blocked.factors.map((item) => item.factor)).toEqual(
      expect.arrayContaining(["routes", "external_services"]),
    );
    expect(blocked.factors.reduce((sum, item) => sum + item.points, 0)).toBeGreaterThanOrEqual(blocked.score);

    writeFiles(root, { LICENSE: MIT_TEXT });
    const allowed = assessFeasibility(
      trace,
      compareStacks(source, target.profile, trace.external_packages),
      await checkLicense(root, target.root, { maxFileBytes: MAX }),
      await scanRepository(root, { maxFileBytes: MAX }),
    );
    expect(allowed.go).toBe(true);
  });
});
