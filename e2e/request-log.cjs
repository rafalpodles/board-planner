// Loaded into the app server under test, next to keep-idle-connections.cjs. With
// E2E_REQUEST_LOG_DIR set, every request is appended to a file of this process's own, for
// e2e/route-groups.ts to attribute to the test that made it (BP-1081). A browser sends
// Sec-Fetch-Dest; Playwright's API request context and Node's own fetch do not (Node's does send
// Sec-Fetch-Mode), which is what `direct` records.
const dir = process.env.E2E_REQUEST_LOG_DIR;

if (dir) {
  const { appendFileSync, mkdirSync } = require("node:fs");
  const http = require("node:http");
  const { join } = require("node:path");

  mkdirSync(dir, { recursive: true });
  const file = join(dir, `requests-${process.pid}.ndjson`);

  const createServer = http.createServer;
  http.createServer = function createServerLoggingRequests(...args) {
    const server = createServer.apply(this, args);
    server.on("request", (req) => {
      const path = (req.url ?? "").split("?")[0];
      if (path.startsWith("/_next/")) return;
      const line = { t: Date.now(), method: req.method, path, direct: !req.headers["sec-fetch-dest"] };
      appendFileSync(file, `${JSON.stringify(line)}\n`);
    });
    return server;
  };
}
