import { createServer } from "node:http";

/**
 * A webhook endpoint on this machine that records everything it is sent.
 *
 * Its own process rather than a server inside the Playwright worker, and not for tidiness: it has
 * to outlive the request. `dispatchWebhooks` does not await its own fetch, so the delivery is
 * attempted *after* the route has answered and after the test's `await request.post(...)` has
 * resolved — by which time a receiver opened in the test body and closed in its `finally` is gone,
 * and the app's connect is refused or reset. A lifetime problem, not a reachability one: Playwright
 * imposes no network isolation, and the in-worker receiver in mcp-oauth.spec.ts works because the
 * browser navigates to it while the test is still waiting.
 *
 * No SIGTERM handler, deliberately: if a run is killed hard this process survives holding the port,
 * and `reuseExistingServer: false` then stops the next run with "already used" rather than quietly
 * attaching it to a receiver still holding the last run's deliveries. Clear it with
 * `lsof -ti:<port> | xargs kill`.
 *
 * GET /deliveries returns what has arrived, POST /reset clears it, and everything else is recorded.
 */

// Loopback only. Bound to every interface on a machine several agents share, `/deliveries` hands
// anybody on the network the payloads this instance sent, and `/reset` lets them erase a delivery
// that had already been recorded — turning the instrument from a false red into a false green.
const LOOPBACK = "127.0.0.1";

const PORT = Number(process.env.WEBHOOK_RECEIVER_PORT ?? 3990);

let deliveries = [];

function json(res, body) {
  const payload = JSON.stringify(body);
  res.writeHead(200, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

const server = createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "Content-Type": "text/plain" }).end("ok");
    return;
  }

  if (req.url === "/deliveries") {
    json(res, deliveries);
    return;
  }

  if (req.url === "/reset") {
    deliveries = [];
    json(res, { ok: true });
    return;
  }

  let body = "";
  req.on("data", (chunk) => (body += chunk));
  req.on("end", () => {
    deliveries.push({ method: req.method, url: req.url, headers: req.headers, body });
    json(res, { received: true });
  });
});

server.listen(PORT, LOOPBACK, () => console.log(`webhook receiver listening on ${PORT}`));
