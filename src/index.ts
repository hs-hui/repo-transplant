import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer, VERSION } from "./server.js";

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
  const shutdown = (): void => {
    server.close().finally(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((error) => {
  process.stderr.write(
    `repo-transplant-mcp failed to start: ${error instanceof Error ? error.stack : String(error)}\n`,
  );
  process.exit(1);
});
