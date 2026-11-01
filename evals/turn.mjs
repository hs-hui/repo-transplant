// Runs one headless Claude Code turn against an eval target, as a user would.
// usage: node turn.mjs <name> <target dir> <session uuid> <new|resume> <prompt file>
import { spawn } from "node:child_process";
import { appendFileSync, createWriteStream, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";

const [name, target, session, mode, promptFile] = process.argv.slice(2);
const here = import.meta.dirname;
const runs = path.join(here, "runs", name);
mkdirSync(runs, { recursive: true });

const P = "mcp__plugin_repo-transplant_repo-transplant__*";
const args = [
  "-p",
  "--plugin-dir",
  path.resolve(here, "..", "plugin"),
  "--output-format",
  "stream-json",
  "--verbose",
  "--model",
  process.env.EVAL_MODEL ?? "claude-sonnet-5-5",
  "--max-budget-usd",
  process.env.EVAL_BUDGET ?? "12",
  "--permission-mode",
  "acceptEdits",
  "--allowedTools",
  P,
  "Read",
  "Write",
  "Edit",
  "Glob",
  "Grep",
  "Skill",
  "Agent",
  "--disallowedTools",
  "WebFetch",
  "WebSearch",
];
args.push(...(mode === "new" ? ["--session-id", session] : ["--resume", session]));

const log = createWriteStream(path.join(runs, "events.jsonl"), { flags: "a" });
const child = spawn("claude", args, {
  cwd: target,
  shell: process.platform === "win32",
  stdio: ["pipe", "pipe", "pipe"],
  env: { ...process.env, CLAUDE_PLUGIN_ROOT: undefined },
});
child.stdin.end(readFileSync(promptFile, "utf8"));
child.stdout.pipe(log);
child.stderr.on("data", (chunk) => appendFileSync(path.join(runs, "stderr.log"), chunk));
child.on("close", (code) => {
  console.log(`${name} turn finished with exit code ${code}`);
});
