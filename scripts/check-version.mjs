// Fails the release when package.json and the plugin manifests disagree with the tag.
import { readFileSync } from "node:fs";

const expected = process.argv[2];
const read = (file) => JSON.parse(readFileSync(file, "utf8"));
const versions = {
  "package.json": read("package.json").version,
  "plugin/.claude-plugin/plugin.json": read("plugin/.claude-plugin/plugin.json").version,
  ".claude-plugin/marketplace.json": read(".claude-plugin/marketplace.json").plugins[0].version,
};

const wrong = Object.entries(versions).filter(([, version]) => version !== expected);
if (wrong.length > 0) {
  for (const [file, version] of wrong) console.error(`${file} is ${version}, expected ${expected}`);
  process.exit(1);
}
console.log(`All manifests are at ${expected}`);
