import { createServer } from "node:http";

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
