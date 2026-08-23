import { createServer } from "node:http";

/**
 * A webhook endpoint on this machine that records everything it is sent.
 *
 * Its own process rather than a server inside the Playwright worker, and not for tidiness: a
 * listener opened by the test worker is reachable from the browser but not from the dev server —
 * the app's fetch to it is refused at connect — so a test hosting its own receiver would read an
 * empty log whatever the app did. The stubs beside this file are separate processes for the same
 * reason.
 *
 * GET /deliveries returns what has arrived, POST /reset clears it, and everything else is recorded.
 */

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

server.listen(PORT, () => console.log(`webhook receiver listening on ${PORT}`));
