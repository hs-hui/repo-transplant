// Runs the built server against real public repositories over stdio. Needs network access.
// Usage: node scripts/smoke.mjs [owner/repo:query:seed ...]
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const DEFAULT_CASES = [
  "pacocoursey/cmdk:command palette",
  "gothinkster/node-express-realworld-example-app:로그인 인증",
  "fastapi/full-stack-fastapi-template:password recovery email",
];

const client = new Client({ name: "smoke", version: "1.0.0" });
await client.connect(
  new StdioClientTransport({
    command: process.execPath,
    args: ["plugin/dist/server.mjs"],
    env: { ...process.env, RT_HOME: process.env.RT_HOME ?? path.join(os.tmpdir(), "rt-smoke") },
  }),
);

async function call(name, args) {
  const result = await client.callTool({ name, arguments: args });
  const text = result.content[0].text;
  if (result.isError) throw new Error(`${name}: ${text}`);
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

const { tools } = await client.listTools();
console.log(`${tools.length} tools registered`);

for (const entry of process.argv.slice(2).length ? process.argv.slice(2) : DEFAULT_CASES) {
  const [repository, query] = entry.split(":");
  console.log(`\n=== ${repository} / ${query}`);
  const started = Date.now();
  const fetched = await call("repo_fetch", { repository });
  console.log(`fetched ${fetched.sha.slice(0, 12)} in ${Date.now() - started}ms`);

  const profile = await call("repo_profile", { snapshot_id: fetched.snapshot_id });
  console.log(
    "languages",
    profile.languages
      .slice(0, 3)
      .map((item) => `${item.language} ${item.share}%`)
      .join(", "),
  );
  console.log("stack", JSON.stringify(profile.stack));
  console.log(
    "package manager",
    profile.packageManager,
    "| commands",
    profile.suggested_commands.map((item) => item.command).join(" ; "),
  );

  const license = await call("license_check", { snapshot_id: fetched.snapshot_id });
  console.log("license", license.source.spdx, license.source.class, "->", license.verdict);

  const search = await call("feature_search", { snapshot_id: fetched.snapshot_id, query, limit: 8 });
  console.log("terms", search.terms.join(" "));
  console.log(
    "top hits",
    search.hits.slice(0, 5).map((hit) => `${hit.path} (${hit.score})`),
  );
  console.log("seeds", search.suggested_seeds);
  if (search.suggested_seeds.length === 0) continue;

  const trace = await call("feature_trace", {
    snapshot_id: fetched.snapshot_id,
    seeds: search.suggested_seeds.slice(0, 2),
  });
  console.log(
    "trace",
    JSON.stringify({
      files: trace.totals.files,
      shared: trace.shared_infrastructure.length,
      externals: trace.external_packages.length,
      tests: trace.tests.length,
      integration: trace.integration_points.length,
      unresolved: trace.unresolved.length,
      routes: trace.backend.routes.length,
      models: trace.backend.data.length,
      migrations: trace.backend.migrations.length,
      env: trace.backend.env_vars.map((item) => item.name),
      services: trace.backend.external_services.map((item) => item.service),
      truncated: trace.truncated,
    }),
  );
  const scan = await call("security_scan", { snapshot_id: fetched.snapshot_id, limit: 5 });
  console.log("security", scan.risk, JSON.stringify(scan.counts));
  for (const item of scan.findings.slice(0, 5))
    console.log("  ", item.severity, item.rule, item.path, item.excerpt.slice(0, 90));
  const backend = await call("backend_surface", { snapshot_id: fetched.snapshot_id });
  console.log(
    "backend",
    JSON.stringify({
      routes: backend.routes.length,
      sample: backend.routes
        .slice(0, 4)
        .map((route) => `${route.method} ${route.path} [auth:${route.auth_hint ?? "-"}]`),
      data: backend.data.length,
      migrations: backend.migrations.length,
      env: backend.env_vars.length,
    }),
  );
}
await client.close();
