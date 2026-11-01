import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("plugin folder", () => {
  it("is what the marketplace installs", () => {
    const marketplace = JSON.parse(readFileSync(".claude-plugin/marketplace.json", "utf8"));
    expect(marketplace.plugins[0].source).toBe("./plugin");
    expect(existsSync("plugin/.claude-plugin/plugin.json")).toBe(true);
  });

  it("has nothing that makes an install run npm ci", () => {
    for (const file of ["package.json", "package-lock.json", "npm-shrinkwrap.json", "bun.lock"]) {
      expect(existsSync(`plugin/${file}`)).toBe(false);
    }
  });
});
