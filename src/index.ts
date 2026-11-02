import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer, VERSION } from "./server.js";
import { stopContainers } from "./session/verify.js";

const HELP = `repo-transplant-mcp ${VERSION}

MCP server over stdio that transplants features between repositories.

Environment:
  RT_HOME               State directory (default ~/.repo-transplant)
  RT_ALLOWED_HOSTS      Comma-separated git hosts (default github.com)
  RT_MAX_REPO_MB        Largest repository to fetch (default 2048)
  RT_GIT_TIMEOUT_MS     Git network timeout (default 300000)
  RT_MAX_FILE_BYTES     Largest file to analyze (default 1048576)
  RT_MAX_OUTPUT_CHARS   Largest tool response (default 60000)
`;

const SHUTDOWN_LIMIT_MS = 5000;

async function main(): Promise<void> {
  const flag = process.argv[2];
  if (flag === "--version" || flag === "-v") {
    process.stdout.write(`${VERSION}\n`);
    return;
  }
  if (flag === "--help" || flag === "-h") {
    process.stdout.write(HELP);
    return;
  }
  const server = createServer();
  await server.connect(new StdioServerTransport());
  let stopping = false;
  const shutdown = (): void => {
    if (stopping) return;
    stopping = true;
    // Taken before closing, because closing ends the runs that keep these names.
    const stopped = Promise.race([
      stopContainers(),
      new Promise((resolve) => setTimeout(resolve, SHUTDOWN_LIMIT_MS)),
    ]);
    server
      .close()
      .catch(() => undefined)
      .then(() => stopped)
      .finally(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  // Windows has no signal to catch when a client stops a server, but clients end stdin first.
  process.stdin.once("end", shutdown);
}

main().catch((error) => {
  process.stderr.write(
    `repo-transplant-mcp failed to start: ${error instanceof Error ? error.stack : String(error)}\n`,
  );
  process.exit(1);
});
