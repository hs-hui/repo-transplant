import { chmod, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { build } from "esbuild";

const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));

await mkdir("plugin/dist", { recursive: true });
const result = await build({
  entryPoints: ["src/index.ts"],
  outfile: "plugin/dist/server.mjs",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  legalComments: "none",
  minifySyntax: true,
  metafile: true,
  define: { __RT_VERSION__: JSON.stringify(pkg.version) },
  banner: {
    js: [
      "#!/usr/bin/env node",
      'import { createRequire as __rtCreateRequire } from "node:module";',
      "const require = __rtCreateRequire(import.meta.url);",
    ].join("\n"),
  },
});
await chmod("plugin/dist/server.mjs", 0o755);

// The bundle redistributes its dependencies, so it carries their license texts.
const packages = new Set();
for (const input of Object.keys(result.metafile.inputs)) {
  const match = input.match(/^node_modules\/((?:@[^/]+\/)?[^/]+)\//);
  if (match) packages.add(match[1]);
}

const sections = [];
for (const name of [...packages].sort()) {
  const directory = path.join("node_modules", ...name.split("/"));
  const manifest = JSON.parse(await readFile(path.join(directory, "package.json"), "utf8"));
  const licenseFile = (await readdir(directory)).find((entry) => /^(licen[cs]e|copying)/i.test(entry));
  const text = licenseFile
    ? await readFile(path.join(directory, licenseFile), "utf8")
    : "No license file shipped.";
  const license = typeof manifest.license === "string" ? manifest.license : "see below";
  sections.push(`## ${name}@${manifest.version} (${license})\n\n${text.trim()}\n`);
}
await writeFile(
  "plugin/dist/THIRD_PARTY_LICENSES.md",
  `# Third-party licenses\n\ndist/server.mjs bundles the following packages.\n\n${sections.join("\n")}`,
);
