import path from "node:path";
import { lineLocator } from "../util/text.js";
import { EXTERNAL_SERVICES } from "./catalog.js";
import type { RepoGraph } from "./graph.js";

export interface RouteSurface {
  method: string;
  path: string;
  file: string;
  line: number;
  style: string;
  auth_hint: string | null;
}

export interface DataSurface {
  kind: string;
  file: string;
  line: number | null;
  name: string | null;
}

export interface BackendSurface {
  has_backend: boolean;
  routes: RouteSurface[];
  data: DataSurface[];
  migrations: string[];
  env_vars: { name: string; files: string[]; likely_secret: boolean }[];
  jobs: { kind: string; file: string; line: number }[];
  realtime: { kind: string; file: string; line: number }[];
  external_services: { service: string; package: string; files: string[] }[];
  auth_files: string[];
  middleware: string[];
  truncated: boolean;
}

const AUTH_HINT =
  /(requireAuth|isAuthenticated|authenticate|authorize|authGuard|ensureAuth|withAuth|protectedProcedure|verifyToken|verifyJwt|jwtRequired|jwt_required|login_required|permission_required|get_current_user|current_user|@UseGuards|@PreAuthorize|\[Authorize\]|before_action\s+:authenticate|middleware\(['"]auth|getServerSession|auth\(\)|currentUser\(\)|getUser\(\)|requireUser|requireSession|CurrentUser|CurrentSuperuser|get_current_\w*user|\bauth\.\w+|\bauthMiddleware\b|\bauthenticated\b)/;

interface RoutePattern {
  style: string;
  pattern: RegExp;
  method: (match: RegExpMatchArray) => string;
  path: (match: RegExpMatchArray) => string;
  extensions: string[];
}

const JS = [".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs"];
const upper = (index: number) => (match: RegExpMatchArray) => (match[index] ?? "ANY").toUpperCase();
const group = (index: number) => (match: RegExpMatchArray) => match[index] ?? "";

const ROUTE_PATTERNS: RoutePattern[] = [
  {
    style: "express_like",
    pattern:
      /\b(?:app|router|server|fastify|api|route|routes|r|v\d|hono)\.(get|post|put|patch|delete|all|head|options)\(\s*['"`]([^'"`]+)['"`]/g,
    method: upper(1),
    path: group(2),
    extensions: JS,
  },
  {
    style: "nest",
    pattern: /@(Get|Post|Put|Patch|Delete|All)\(\s*(?:['"`]([^'"`]*)['"`])?\s*\)/g,
    method: upper(1),
    path: group(2),
    extensions: [".ts", ".js"],
  },
  {
    style: "trpc",
    pattern: /\b(\w+)\s*:\s*(?:public|protected|admin|authed)?[Pp]rocedure\b/g,
    method: () => "RPC",
    path: group(1),
    extensions: JS,
  },
  {
    style: "python_decorator",
    pattern: /@(?:\w+)\.(get|post|put|patch|delete|route|websocket)\(\s*f?['"]([^'"]*)['"]/g,
    method: upper(1),
    path: group(2),
    extensions: [".py"],
  },
  {
    style: "django_urls",
    pattern: /\b(?:path|re_path)\(\s*r?['"]([^'"]*)['"]/g,
    method: () => "ANY",
    path: group(1),
    extensions: [".py"],
  },
  {
    style: "go_router",
    pattern: /\.(GET|POST|PUT|PATCH|DELETE|Get|Post|Put|Patch|Delete|HandleFunc|Handle)\(\s*"([^"]+)"/g,
    method: (match) => (/^Handle/.test(match[1]!) ? "ANY" : match[1]!.toUpperCase()),
    path: group(2),
    extensions: [".go"],
  },
  {
    style: "rails_routes",
    pattern: /^\s*(get|post|put|patch|delete|resources?)\s+['":]([\w/:-]+)/gm,
    method: upper(1),
    path: group(2),
    extensions: [".rb"],
  },
  {
    style: "laravel",
    pattern: /Route::(get|post|put|patch|delete|any|resource|apiResource)\(\s*['"]([^'"]+)['"]/g,
    method: upper(1),
    path: group(2),
    extensions: [".php"],
  },
  {
    style: "spring",
    pattern: /@(Get|Post|Put|Patch|Delete|Request)Mapping\(\s*(?:value\s*=\s*|path\s*=\s*)?"?([^")]*)"?/g,
    method: upper(1),
    path: group(2),
    extensions: [".java", ".kt"],
  },
  {
    style: "rust_attribute",
    pattern: /#\[(get|post|put|patch|delete)\(\s*"([^"]+)"/g,
    method: upper(1),
    path: group(2),
    extensions: [".rs"],
  },
  {
    style: "axum",
    pattern: /\.route\(\s*"([^"]+)"\s*,\s*(get|post|put|patch|delete)/g,
    method: upper(2),
    path: group(1),
    extensions: [".rs"],
  },
  {
    style: "aspnet",
    pattern:
      /(?:\[Http(Get|Post|Put|Patch|Delete)\(\s*"([^"]*)"|\.Map(Get|Post|Put|Patch|Delete)\(\s*"([^"]+)")/g,
    method: (match) => (match[1] ?? match[3] ?? "ANY").toUpperCase(),
    path: (match) => match[2] ?? match[4] ?? "",
    extensions: [".cs"],
  },
];

const ENV_PATTERNS = [
  /\bprocess\.env\.([A-Z][A-Z0-9_]+)/g,
  /\bprocess\.env\[\s*['"`]([A-Z][A-Z0-9_]+)['"`]\s*\]/g,
  /\bimport\.meta\.env\.([A-Z][A-Z0-9_]+)/g,
  /\bDeno\.env\.get\(\s*['"]([A-Z][A-Z0-9_]+)['"]/g,
  /\bBun\.env\.([A-Z][A-Z0-9_]+)/g,
  /\bos\.environ\[\s*['"]([A-Z][A-Z0-9_]+)['"]\s*\]/g,
  /\bos\.environ\.get\(\s*['"]([A-Z][A-Z0-9_]+)['"]/g,
  /\bos\.getenv\(\s*['"]([A-Z][A-Z0-9_]+)['"]/g,
  /\bos\.Getenv\(\s*"([A-Z][A-Z0-9_]+)"/g,
  /\bENV(?:\.fetch\(\s*|\[\s*)['"]([A-Z][A-Z0-9_]+)['"]/g,
  /\benv\(\s*['"]([A-Z][A-Z0-9_]+)['"]/g,
  /\bSystem\.getenv\(\s*"([A-Z][A-Z0-9_]+)"/g,
  /\benv::var\(\s*"([A-Z][A-Z0-9_]+)"/g,
  /\bEnvironment\.GetEnvironmentVariable\(\s*"([A-Z][A-Z0-9_]+)"/g,
];

const DATA_PATTERNS: { kind: string; pattern: RegExp; extensions?: string[] }[] = [
  { kind: "prisma_model", pattern: /^model\s+(\w+)\s*\{/gm, extensions: [".prisma"] },
  { kind: "drizzle_table", pattern: /\b(?:pg|mysql|sqlite)Table\(\s*['"`](\w+)['"`]/g, extensions: JS },
  { kind: "mongoose_model", pattern: /\b(?:mongoose\.)?model\(\s*['"`](\w+)['"`]\s*,/g, extensions: JS },
  {
    kind: "typeorm_entity",
    pattern: /@Entity\([^)\n]{0,200}\)\s*(?:export\s+)?class\s+(\w+)/g,
    extensions: [".ts", ".js"],
  },
  { kind: "sequelize_model", pattern: /\b\w+\.define\(\s*['"`](\w+)['"`]\s*,\s*\{/g, extensions: JS },
  {
    kind: "sqlalchemy_model",
    pattern: /^class\s+(\w+)\([^)\n]{0,200}\b(?:Base|DeclarativeBase|SQLModel|db\.Model)\b[^)\n]{0,200}\)/gm,
    extensions: [".py"],
  },
  {
    kind: "django_model",
    pattern: /^class\s+(\w+)\([^)\n]{0,200}models\.Model[^)\n]{0,200}\)/gm,
    extensions: [".py"],
  },
  { kind: "gorm_model", pattern: /type\s+(\w+)\s+struct\s*\{\s*\n?\s*gorm\.Model/g, extensions: [".go"] },
  {
    kind: "activerecord_model",
    pattern: /^\s*class\s+(\w+)\s*<\s*(?:ApplicationRecord|ActiveRecord::Base)/gm,
    extensions: [".rb"],
  },
  { kind: "eloquent_model", pattern: /class\s+(\w+)\s+extends\s+Model\b/g, extensions: [".php"] },
  { kind: "jpa_entity", pattern: /@Entity[\s\S]{0,120}?class\s+(\w+)/g, extensions: [".java", ".kt"] },
  { kind: "ef_dbset", pattern: /DbSet<(\w+)>/g, extensions: [".cs"] },
  {
    kind: "sql_table",
    pattern: /\bCREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?["'`]?(\w+)/gi,
    extensions: [".sql"],
  },
];

const JOB_PATTERNS: { kind: string; pattern: RegExp }[] = [
  { kind: "bullmq", pattern: /\bnew\s+(Queue|Worker)\(\s*['"`]/ },
  { kind: "cron", pattern: /\bcron\.schedule\(|@Cron\(|@Scheduled\(|\bCronJob\(/ },
  { kind: "celery", pattern: /@(shared_task|\w+\.task)\b/ },
  { kind: "sidekiq", pattern: /include\s+Sidekiq::(Worker|Job)|<\s*ApplicationJob/ },
  { kind: "laravel_job", pattern: /implements\s+ShouldQueue/ },
  { kind: "asynq", pattern: /asynq\.NewServer|asynq\.NewClient/ },
];

const REALTIME_PATTERNS: { kind: string; pattern: RegExp }[] = [
  { kind: "socket.io", pattern: /\bnew\s+Server\([^)\n]{0,200}\)|\bio\.on\(\s*['"`]connection/ },
  { kind: "ws", pattern: /\bnew\s+WebSocketServer\(|\bnew\s+WebSocket\.Server\(/ },
  { kind: "nest_gateway", pattern: /@WebSocketGateway\(/ },
  { kind: "sse", pattern: /text\/event-stream/ },
];

const SETTINGS_FIELD = /^\s+([A-Z][A-Z0-9_]+)\s*:/gm;
const ENV_FILE = /(^|\/)\.env(\.[^/]*)?$/;

/** Names read through a declaration rather than a call: dotenv templates and pydantic settings classes. */
function declaredEnvNames(rel: string, text: string): string[] {
  if (ENV_FILE.test(rel)) {
    return [...text.matchAll(/^\s*(?:export\s+)?([A-Z][A-Z0-9_]+)\s*=/gm)].map((match) => match[1]!);
  }
  const settings = text.search(/class\s+\w+\(\s*BaseSettings\s*\)/);
  return settings === -1 ? [] : [...text.slice(settings).matchAll(SETTINGS_FIELD)].map((match) => match[1]!);
}

const MIGRATION_PATH =
  /(^|\/)(migrations?|alembic\/versions|db\/migrate|database\/migrations|prisma\/migrations|drizzle)\/.+\.(sql|py|rb|php|ts|js|go|xml|ya?ml)$/;

function fileBasedRoute(rel: string, text: string): RouteSurface[] {
  const lineAt = lineLocator(text);
  const routes: RouteSurface[] = [];
  const app = rel.match(/(?:^|\/)app((?:\/.*)?)\/route\.[jt]sx?$/);
  const sveltekit = rel.match(/(?:^|\/)routes((?:\/.*)?)\/\+server\.[jt]s$/);
  const pagesApi = rel.match(/(?:^|\/)pages\/api\/(.+)\.[jt]sx?$/);
  const routePath = app?.[1] ?? sveltekit?.[1];
  const auth = text.match(AUTH_HINT)?.[0] ?? null;
  if (routePath !== undefined) {
    const pattern = /export\s+(?:async\s+)?(?:function|const)\s+(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b/g;
    for (const match of text.matchAll(pattern)) {
      routes.push({
        method: match[1]!,
        path: routePath || "/",
        file: rel,
        line: lineAt(match.index),
        style: app ? "next_route_handler" : "sveltekit_endpoint",
        auth_hint: auth,
      });
    }
  }
  if (pagesApi) {
    routes.push({
      method: "ANY",
      path: `/api/${pagesApi[1]!.replace(/\/index$/, "")}`,
      file: rel,
      line: 1,
      style: "next_pages_api",
      auth_hint: auth,
    });
  }
  return routes;
}

function routerPrefix(text: string): string {
  return text.match(/\bAPIRouter\([^)\n]{0,200}\bprefix\s*=\s*['"]([^'"]*)['"]/)?.[1] ?? "";
}

function controllerPrefix(text: string): string {
  return text.match(/@Controller\(\s*['"`]([^'"`]*)['"`]\s*\)/)?.[1] ?? "";
}

const MAX_ROWS = 300;

/** Finds the server-side surface a feature touches: routes, data, env, jobs, realtime and services. */
export function scanBackend(graph: RepoGraph, files?: string[]): BackendSurface {
  const selected = files ?? [...graph.nodes.keys()];
  const routes: RouteSurface[] = [];
  const data: DataSurface[] = [];
  const envFiles = new Map<string, Set<string>>();
  const jobs: BackendSurface["jobs"] = [];
  const realtime: BackendSurface["realtime"] = [];
  const services = new Map<string, { service: string; package: string; files: Set<string> }>();
  const migrations: string[] = [];
  const authFiles: string[] = [];
  const middleware: string[] = [];

  for (const rel of selected) {
    const node = graph.nodes.get(rel);
    if (!node) continue;
    if (MIGRATION_PATH.test(rel)) migrations.push(rel);
    if (node.file.fileClass === "test" || node.file.fileClass === "generated") continue;

    for (const pkg of node.external) {
      const service = EXTERNAL_SERVICES[pkg];
      if (!service) continue;
      const entry = services.get(pkg) ?? { service, package: pkg, files: new Set() };
      entry.files.add(rel);
      services.set(pkg, entry);
    }
    if (/(^|\/)middlewares?(\/|\.)/.test(rel)) middleware.push(rel);
    if (/(^|\/)(auth|authentication|session|guards?|policies)(\/|\.)/i.test(rel)) authFiles.push(rel);

    const text = graph.texts.get(rel);
    if (!text) continue;
    const ext = path.posix.extname(rel).toLowerCase();
    const lineAt = lineLocator(text);

    routes.push(...fileBasedRoute(rel, text));
    const prefix = controllerPrefix(text);
    const pythonPrefix = ext === ".py" ? routerPrefix(text) : "";
    const lines = text.split("\n");
    for (const rule of ROUTE_PATTERNS) {
      if (!rule.extensions.includes(ext)) continue;
      if (rule.style === "django_urls" && path.posix.basename(rel) !== "urls.py") continue;
      if (rule.style === "rails_routes" && !rel.endsWith("routes.rb")) continue;
      for (const match of text.matchAll(rule.pattern)) {
        const line = lineAt(match.index);
        const nearby = lines.slice(Math.max(0, line - 3), line + 6).join("\n");
        routes.push({
          method: rule.method(match),
          path:
            rule.style === "nest"
              ? `/${[prefix, rule.path(match)].filter(Boolean).join("/")}`
              : `${pythonPrefix}${rule.path(match)}`,
          file: rel,
          line,
          style: rule.style,
          auth_hint: nearby.match(AUTH_HINT)?.[0] ?? null,
        });
      }
    }

    for (const rule of DATA_PATTERNS) {
      if (rule.extensions && !rule.extensions.includes(ext)) continue;
      for (const match of text.matchAll(rule.pattern)) {
        data.push({ kind: rule.kind, file: rel, line: lineAt(match.index), name: match[1] ?? null });
      }
    }
    const envNames = [
      ...declaredEnvNames(rel, text),
      ...ENV_PATTERNS.flatMap((pattern) => [...text.matchAll(pattern)].map((match) => match[1]!)),
    ];
    for (const name of envNames) {
      if (name === "NODE_ENV" || name === "PATH" || name === "HOME") continue;
      const set = envFiles.get(name) ?? new Set<string>();
      set.add(rel);
      envFiles.set(name, set);
    }
    lines.forEach((line, index) => {
      for (const rule of JOB_PATTERNS) {
        if (rule.pattern.test(line)) jobs.push({ kind: rule.kind, file: rel, line: index + 1 });
      }
      for (const rule of REALTIME_PATTERNS) {
        if (rule.pattern.test(line)) realtime.push({ kind: rule.kind, file: rel, line: index + 1 });
      }
    });
  }

  const secretName = /(SECRET|TOKEN|KEY|PASSWORD|PASS|CREDENTIAL|DSN|DATABASE_URL|_URI$)/;
  const hasServerSurface = routes.length + data.length + migrations.length + jobs.length > 0;
  return {
    has_backend: hasServerSurface,
    routes: routes.slice(0, MAX_ROWS),
    data: data.slice(0, MAX_ROWS),
    migrations: migrations.slice(0, MAX_ROWS),
    env_vars: [...envFiles.entries()]
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([name, set]) => ({ name, files: [...set].slice(0, 8), likely_secret: secretName.test(name) })),
    jobs: jobs.slice(0, MAX_ROWS),
    realtime: realtime.slice(0, MAX_ROWS),
    external_services: [...services.values()].map((entry) => ({
      service: entry.service,
      package: entry.package,
      files: [...entry.files].slice(0, 8),
    })),
    auth_files: authFiles.slice(0, 60),
    middleware: middleware.slice(0, 60),
    truncated: routes.length > MAX_ROWS || data.length > MAX_ROWS || jobs.length > MAX_ROWS,
  };
}
