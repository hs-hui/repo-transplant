// Summarizes a run: tool calls in order, errors, and the last assistant text.
import { readFileSync } from "node:fs";
import path from "node:path";

const name = process.argv[2];
const events = readFileSync(path.join(import.meta.dirname, "runs", name, "events.jsonl"), "utf8")
  .split("\n")
  .filter(Boolean)
  .flatMap((line) => {
    try {
      return [JSON.parse(line)];
    } catch {
      return [];
    }
  });

const short = (tool) => tool.replace("mcp__plugin_repo-transplant_repo-transplant__", "");
const names = new Map();
let lastText = "";
const rows = [];
for (const event of events) {
  if (event.type === "system" && event.subtype === "init") {
    rows.push(
      `INIT tools=${event.tools.filter((t) => t.includes("transplant")).length} plugins=${JSON.stringify(event.plugins ?? [])}`,
    );
  }
  for (const part of event.message?.content ?? []) {
    if (part.type === "text" && event.type === "assistant") lastText = part.text;
    if (part.type === "tool_use") {
      names.set(part.id, short(part.name));
      const input = JSON.stringify(part.input).slice(0, 110);
      rows.push(`> ${short(part.name)} ${input}`);
    }
    if (part.type === "tool_result" && part.is_error) {
      const text = typeof part.content === "string" ? part.content : JSON.stringify(part.content);
      rows.push(`  ! ${names.get(part.tool_use_id)}: ${text.slice(0, 400)}`);
    }
  }
  if (event.type === "result") {
    rows.push(
      `RESULT ${event.subtype} turns=${event.num_turns} cost=$${event.total_cost_usd?.toFixed(2)} ${Math.round(event.duration_ms / 1000)}s`,
    );
  }
}
console.log(rows.join("\n"));
console.log("\n--- last assistant text ---\n" + lastText);
