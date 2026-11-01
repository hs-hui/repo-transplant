import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll } from "vitest";
import { type Config, loadConfig } from "../src/config.js";

const created: string[] = [];

export function tempDir(prefix = "rt-test-"): string {
  const directory = mkdtempSync(path.join(os.tmpdir(), prefix));
  created.push(directory);
  return directory;
}

export function testConfig(): Config {
  return loadConfig({ RT_HOME: tempDir("rt-home-") });
}

export function writeFiles(root: string, files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    const file = path.join(root, rel);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, content);
  }
}

export function gitIn(root: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

export function createRepo(files: Record<string, string>, prefix = "rt-repo-"): string {
  const root = tempDir(prefix);
  writeFiles(root, files);
  gitIn(root, "init", "-q", "-b", "main");
  gitIn(root, "config", "user.email", "test@example.com");
  gitIn(root, "config", "user.name", "Test");
  gitIn(root, "config", "commit.gpgsign", "false");
  gitIn(root, "config", "core.autocrlf", "false");
  gitIn(root, "add", "-A");
  gitIn(root, "commit", "-q", "-m", "initial");
  return root;
}

export const MIT_TEXT = `MIT License

Copyright (c) 2024 Example Author

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND.
`;

export const GPL3_TEXT = `GNU GENERAL PUBLIC LICENSE
Version 3, 29 June 2007
`;

export const AGPL_TEXT = `GNU AFFERO GENERAL PUBLIC LICENSE
Version 3, 19 November 2007
The GNU General Public License is a free, copyleft license.
`;

// Async on purpose: rmSync in Node 24 aborts the process on non-ASCII Windows paths.
afterAll(async () => {
  for (const directory of created.splice(0)) {
    await rm(directory, { recursive: true, force: true, maxRetries: 5 });
  }
});
