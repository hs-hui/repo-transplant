import { resolveExpression } from "./license.js";
import type { Ecosystem } from "./manifests.js";

export interface PackageInfo {
  ecosystem: Ecosystem;
  name: string;
  exists: boolean | null;
  latest: string | null;
  license: string | null;
  license_class: string | null;
  deprecated: string | null;
  first_published: string | null;
  last_published: string | null;
  flags: string[];
  error?: string;
}

// biome-ignore lint/suspicious/noExplicitAny: registry responses are external JSON read defensively.
type Json = Record<string, any>;

async function getJson(url: string): Promise<{ status: number; body: Json | null }> {
  const response = await fetch(url, {
    headers: { accept: "application/json", "user-agent": "repo-transplant-mcp" },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) return { status: response.status, body: null };
  return { status: response.status, body: (await response.json()) as Json };
}

function blank(ecosystem: Ecosystem, name: string): PackageInfo {
  return {
    ecosystem,
    name,
    exists: null,
    latest: null,
    license: null,
    license_class: null,
    deprecated: null,
    first_published: null,
    last_published: null,
    flags: [],
  };
}

async function inspectNpm(info: PackageInfo): Promise<void> {
  const { status, body } = await getJson(`https://registry.npmjs.org/${info.name.replace("/", "%2F")}`);
  if (status === 404) {
    info.exists = false;
    return;
  }
  if (!body) throw new Error(`registry returned ${status}`);
  info.exists = true;
  const latest = body["dist-tags"]?.latest as string | undefined;
  info.latest = latest ?? null;
  const manifest = latest ? body.versions?.[latest] : undefined;
  info.license = typeof manifest?.license === "string" ? manifest.license : (manifest?.license?.type ?? null);
  info.deprecated = manifest?.deprecated ?? null;
  info.first_published = body.time?.created ?? null;
  info.last_published = latest ? (body.time?.[latest] ?? null) : null;
  const scripts = manifest?.scripts ?? {};
  for (const hook of ["preinstall", "install", "postinstall"]) {
    if (scripts[hook]) info.flags.push(`Runs a ${hook} script on install.`);
  }
}

async function inspectPypi(info: PackageInfo): Promise<void> {
  const { status, body } = await getJson(`https://pypi.org/pypi/${encodeURIComponent(info.name)}/json`);
  if (status === 404) {
    info.exists = false;
    return;
  }
  if (!body) throw new Error(`registry returned ${status}`);
  info.exists = true;
  info.latest = body.info?.version ?? null;
  info.license = body.info?.license_expression || body.info?.license?.slice(0, 80) || null;
  const uploads = Object.values(body.releases ?? {}).flat() as { upload_time_iso_8601?: string }[];
  const times = uploads
    .map((item) => item.upload_time_iso_8601)
    .filter(Boolean)
    .sort() as string[];
  info.first_published = times[0] ?? null;
  info.last_published = times.at(-1) ?? null;
}

async function inspectCrates(info: PackageInfo): Promise<void> {
  const { status, body } = await getJson(`https://crates.io/api/v1/crates/${encodeURIComponent(info.name)}`);
  if (status === 404) {
    info.exists = false;
    return;
  }
  if (!body) throw new Error(`registry returned ${status}`);
  info.exists = true;
  info.latest = body.crate?.max_stable_version ?? body.crate?.max_version ?? null;
  info.license = body.versions?.[0]?.license ?? null;
  info.first_published = body.crate?.created_at ?? null;
  info.last_published = body.crate?.updated_at ?? null;
}

const INSPECTORS: Partial<Record<Ecosystem, (info: PackageInfo) => Promise<void>>> = {
  npm: inspectNpm,
  pypi: inspectPypi,
  cargo: inspectCrates,
};

/** Checks that a package is real before it enters a plan, which guards against invented or typosquatted names. */
export async function inspectPackage(ecosystem: Ecosystem, name: string): Promise<PackageInfo> {
  const info = blank(ecosystem, name);
  const inspect = INSPECTORS[ecosystem];
  if (!inspect) {
    info.error = `Registry lookup is not implemented for ${ecosystem}.`;
    return info;
  }
  try {
    await inspect(info);
  } catch (error) {
    info.error = error instanceof Error ? error.message : String(error);
    return info;
  }
  if (info.exists === false) {
    info.flags.push("Package does not exist in the registry. It may be an invented or misspelled name.");
    return info;
  }
  if (info.license) {
    const resolved = resolveExpression(info.license);
    info.license_class = resolved.class;
    if (
      ["strong_copyleft", "network_copyleft", "source_available", "non_commercial"].includes(resolved.class)
    ) {
      info.flags.push(`License ${info.license} is restrictive (${resolved.class}).`);
    }
  } else {
    info.flags.push("No license declared.");
  }
  if (info.deprecated) info.flags.push("Deprecated by its maintainers.");
  if (info.first_published) {
    const ageDays = (Date.now() - Date.parse(info.first_published)) / 86_400_000;
    if (ageDays < 30) info.flags.push(`First published ${Math.round(ageDays)} days ago.`);
  }
  return info;
}
