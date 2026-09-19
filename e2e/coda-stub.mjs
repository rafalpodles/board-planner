import { readBody, serve } from "./stub-guard.mjs";

/**
 * A stand-in for the Coda API, so a project's Coda sync (`src/lib/coda.ts`) runs end to end
 * without a real doc, a real token or a rate limit. `codaHost` is a per-project settings field
 * rather than a global env var, so unlike the OpenAI/OpenRouter stubs nothing here is wired into
 * the app automatically — a spec points a project's Host field at this stub's URL through the
 * settings form, the same way it would type in `https://coda.io`. `isAllowedMcpServerUrl` allows a
 * loopback host outside production, which is what makes that legitimate rather than a guard
 * bypass (BP-472).
 *
 * `POST /control` scripts what the columns endpoint answers next: `{ columns: [...] }`. Defaults
 * to every column the app requires, so a spec only calls it to test the missing-columns path.
 * `GET /last-upsert` returns the most recent rows body, so a spec can assert what was pushed
 * without a real Coda table to look at.
 */

const LOOPBACK = "127.0.0.1";
const PORT = Number(process.env.CODA_STUB_PORT ?? 3998);

const DEFAULT_COLUMNS = ["Key", "Title", "Status", "Assignee", "Priority", "Difficulty", "Category", "Due", "Link"];

let columns = DEFAULT_COLUMNS;
let lastUpsert = null;
let requestCount = 0;

function json(res, body, status = 200) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

serve({
  name: "coda stub",
  port: PORT,
  host: LOOPBACK,
  handler: async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${LOOPBACK}`);

    if (url.pathname === "/health") {
      res.writeHead(200, { "Content-Type": "text/plain" }).end("ok");
      return;
    }

    if (req.method === "POST" && url.pathname === "/control") {
      const body = JSON.parse((await readBody(req)) || "{}");
      columns = Array.isArray(body.columns) ? body.columns : DEFAULT_COLUMNS;
      lastUpsert = null;
      requestCount = 0;
      json(res, { ok: true });
      return;
    }

    if (url.pathname === "/last-upsert") {
      json(res, { upsert: lastUpsert, requestCount });
      return;
    }

    // /apis/v1/docs/:docId/tables/:tableId/columns
    const columnsMatch = /^\/apis\/v1\/docs\/[^/]+\/tables\/[^/]+\/columns$/.exec(url.pathname);
    if (req.method === "GET" && columnsMatch) {
      json(res, { items: columns.map((name, i) => ({ id: `c-${i}`, name })) });
      return;
    }

    // POST /apis/v1/docs/:docId/tables/:tableId/rows
    const rowsMatch = /^\/apis\/v1\/docs\/[^/]+\/tables\/[^/]+\/rows$/.exec(url.pathname);
    if (req.method === "POST" && rowsMatch) {
      lastUpsert = JSON.parse((await readBody(req)) || "{}");
      requestCount += 1;
      json(res, { requestId: `req-${requestCount}` });
      return;
    }

    // GET /apis/v1/mutationStatus/:requestId — completed on the first poll, since nothing here
    // needs the real queue-then-poll latency the production API has
    if (req.method === "GET" && /^\/apis\/v1\/mutationStatus\/[^/]+$/.test(url.pathname)) {
      json(res, { completed: true });
      return;
    }

    res.writeHead(404).end();
  },
});
