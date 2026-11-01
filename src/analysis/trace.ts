import path from "node:path";
import { TransplantError } from "../util/errors.js";
import { assertSafeRelative } from "../util/fsx.js";
import { type BackendSurface, scanBackend } from "./backend.js";
import { productionFanIn, type RepoGraph } from "./graph.js";

export interface TraceOptions {
  seeds: string[];
  maxDepth?: number;
  maxFiles?: number;
  exclude?: string[];
  includeReverse?: boolean;
}

export interface TraceResult {
  seeds: string[];
  files: { path: string; depth: number; file_class: string; bytes: number; fan_in: number }[];
  shared_infrastructure: { path: string; fan_in: number; reason: string }[];
  external_packages: string[];
  tests: string[];
  assets: string[];
  integration_points: { path: string; imports: string[] }[];
  unresolved: { file: string; specifier: string }[];
  excluded: string[];
  backend: BackendSurface;
  totals: { files: number; bytes: number };
  truncated: boolean;
  limitations: string[];
}

function expandSeeds(graph: RepoGraph, seeds: string[]): string[] {
  const expanded = new Set<string>();
  for (const raw of seeds) {
    const seed = assertSafeRelative(raw).replace(/\/$/, "");
    if (graph.nodes.has(seed)) {
      expanded.add(seed);
      continue;
    }
    const prefix = `${seed}/`;
    let matched = false;
    for (const [rel, node] of graph.nodes) {
      if (rel.startsWith(prefix) && ["source", "style", "asset"].includes(node.file.fileClass)) {
        expanded.add(rel);
        matched = true;
      }
    }
    if (!matched)
      throw new TransplantError("seed_not_found", `Seed not found: ${raw}`, "Use paths from feature_search.");
  }
  return [...expanded];
}

function relatedTests(graph: RepoGraph, included: Set<string>): string[] {
  const tests = new Set<string>();
  const stems = new Set(
    [...included]
      .map((rel) => path.posix.basename(rel).split(".")[0]!.toLowerCase())
      .filter((stem) => stem.length > 2 && stem !== "index"),
  );
  for (const [rel, node] of graph.nodes) {
    if (node.file.fileClass !== "test") continue;
    const importsIncluded = [...node.internal].some((dep) => included.has(dep));
    const stem = path.posix
      .basename(rel)
      .split(".")[0]!
      .toLowerCase()
      .replace(/^test_|_test$|_spec$|tests?$/g, "");
    if (importsIncluded || stems.has(stem)) tests.add(rel);
  }
  return [...tests].sort().slice(0, 100);
}

/**
 * Schema files are rarely imported: Prisma models arrive through a generated client, and SQL through a
 * migration runner. So the import walk misses them. This links a repository's data models to the closure
 * by name, and brings the migrations along when any model is in use.
 */
function withReferencedData(
  graph: RepoGraph,
  included: Set<string>,
  backend: BackendSurface,
): BackendSurface {
  const known = new Set(backend.data.map((item) => `${item.file}:${item.name}`));
  const words = new Set<string>();
  for (const rel of included) {
    for (const word of (graph.texts.get(rel) ?? "").match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? []) {
      words.add(word.toLowerCase());
    }
  }
  const repository = scanBackend(graph);
  const referenced = repository.data.filter((item) => {
    if (!item.name || known.has(`${item.file}:${item.name}`)) return false;
    const name = item.name.toLowerCase();
    return words.has(name) || words.has(`${name}s`);
  });
  if (referenced.length === 0) return backend;
  return {
    ...backend,
    has_backend: true,
    data: [...backend.data, ...referenced],
    migrations: [...new Set([...backend.migrations, ...repository.migrations])],
  };
}

/**
 * Walks imports from the seed files to the feature's closure. Files imported by a large share of the
 * repository are reported as shared infrastructure and not followed, which stops a feature from
 * dragging in the whole application through a logger or a utils module.
 */
export function traceFeature(graph: RepoGraph, options: TraceOptions): TraceResult {
  const maxDepth = options.maxDepth ?? 6;
  const maxFiles = options.maxFiles ?? 300;
  const sourceCount = [...graph.nodes.values()].filter((node) => node.file.fileClass === "source").length;
  const fanInLimit = Math.max(8, Math.ceil(sourceCount * 0.05));
  const excludes = (options.exclude ?? []).map((item) => item.replace(/\/$/, ""));
  const isExcluded = (rel: string): boolean =>
    excludes.some((item) => rel === item || rel.startsWith(`${item}/`));

  const seeds = expandSeeds(graph, options.seeds);
  const depths = new Map<string, number>();
  const shared = new Map<string, number>();
  const excluded = new Set<string>();
  const queue: string[] = [];
  for (const seed of seeds) {
    depths.set(seed, 0);
    queue.push(seed);
  }

  let truncated = false;
  while (queue.length > 0) {
    const current = queue.shift()!;
    const depth = depths.get(current)!;
    if (depth >= maxDepth) {
      truncated ||= (graph.nodes.get(current)?.internal.size ?? 0) > 0;
      continue;
    }
    for (const dep of graph.nodes.get(current)?.internal ?? []) {
      if (depths.has(dep)) continue;
      if (isExcluded(dep)) {
        excluded.add(dep);
        continue;
      }
      const fanIn = productionFanIn(graph, dep);
      if (fanIn >= fanInLimit) {
        shared.set(dep, fanIn);
        continue;
      }
      if (depths.size >= maxFiles) {
        truncated = true;
        continue;
      }
      depths.set(dep, depth + 1);
      queue.push(dep);
    }
  }

  const included = new Set(depths.keys());
  const externals = new Set<string>();
  const unresolved: TraceResult["unresolved"] = [];
  const assets: string[] = [];
  const files: TraceResult["files"] = [];
  let bytes = 0;
  for (const [rel, depth] of [...depths].sort((a, b) => a[1] - b[1] || (a[0] < b[0] ? -1 : 1))) {
    const node = graph.nodes.get(rel)!;
    for (const pkg of node.external) externals.add(pkg);
    for (const specifier of node.unresolved) unresolved.push({ file: rel, specifier });
    if (node.file.fileClass === "asset") assets.push(rel);
    bytes += node.file.size;
    files.push({
      path: rel,
      depth,
      file_class: node.file.fileClass,
      bytes: node.file.size,
      fan_in: productionFanIn(graph, rel),
    });
  }

  const integration = new Map<string, Set<string>>();
  if (options.includeReverse !== false) {
    for (const rel of included) {
      for (const importer of graph.reverse.get(rel) ?? []) {
        if (included.has(importer) || graph.nodes.get(importer)?.file.fileClass === "test") continue;
        const set = integration.get(importer) ?? new Set<string>();
        set.add(rel);
        integration.set(importer, set);
      }
    }
  }

  // Scanning shared files too keeps auth middleware and env reads in view even though they are not copied.
  const backend = withReferencedData(graph, included, scanBackend(graph, [...included, ...shared.keys()]));
  return {
    seeds,
    files,
    shared_infrastructure: [...shared]
      .sort((a, b) => b[1] - a[1])
      .map(([rel, fanIn]) => ({
        path: rel,
        fan_in: fanIn,
        reason: "Imported across the repository. Map it to the target's equivalent instead of copying it.",
      })),
    external_packages: [...externals].sort(),
    tests: relatedTests(graph, included),
    assets,
    integration_points: [...integration]
      .map(([rel, imports]) => ({ path: rel, imports: [...imports].slice(0, 8) }))
      .slice(0, 60),
    unresolved: unresolved.slice(0, 60),
    excluded: [...excluded],
    backend,
    totals: { files: files.length, bytes },
    truncated,
    limitations: [
      "Dependencies through framework conventions, such as Rails autoloading, Django settings strings or dependency-injection containers, are not import edges. Check integration_points and read the entry files.",
      "C# usings are not resolved to files.",
    ],
  };
}
