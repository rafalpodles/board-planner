import { createServer as createControl } from "node:http";
import { connect, createServer } from "node:net";

const LOOPBACK = "127.0.0.1";

const PORT = Number(process.env.MONGO_PROXY_PORT ?? 3991);
const CONTROL_PORT = Number(process.env.MONGO_PROXY_CONTROL_PORT ?? 3992);

const rawUri = process.env.E2E_MONGODB_URI ?? "mongodb://localhost:27017/boardplanner_e2e";
if (!/^mongodb:\/\/[^,/]+\/[^?]+/.test(rawUri)) {
  console.error(
    "E2E_MONGODB_URI must be a single-host mongodb:// URI naming a database; mongodb+srv and host lists cannot be proxied"
  );
  process.exit(1);
}
const upstream = new URL(rawUri.replace(/^mongodb:\/\//, "http://"));
const UPSTREAM = {
  host: upstream.hostname.replace(/^\[|\]$/g, ""),
  port: Number(upstream.port || 27017),
};

let outage = false;
const live = new Set();

const proxy = createServer((client) => {
  if (outage) {
    client.destroy();
    return;
  }
  const server = connect(UPSTREAM.port, UPSTREAM.host);
  live.add(client);
  const drop = () => {
    live.delete(client);
    client.destroy();
    server.destroy();
  };
  client.on("error", drop).on("close", drop);
  server.on("error", drop).on("close", drop);
  client.pipe(server);
  server.pipe(client);
});

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

const control = createControl((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "Content-Type": "text/plain" }).end("ok");
    return;
  }
  if (req.url === "/sockets") {
    json(res, 200, { live: live.size });
    return;
  }
  if (req.method !== "POST") {
    json(res, 405, { error: "GET /sockets, POST /outage or POST /restore" });
    return;
  }
  if (req.url === "/outage") {
    outage = true;
    for (const socket of live) socket.destroy();
    live.clear();
    json(res, 200, { outage });
    return;
  }
  if (req.url === "/restore") {
    outage = false;
    json(res, 200, { outage });
    return;
  }
  json(res, 404, { error: "unknown control" });
});

proxy.listen(PORT, LOOPBACK, () => {
  control.listen(CONTROL_PORT, LOOPBACK, () => {
    console.log(
      `mongo proxy on ${LOOPBACK}:${PORT} -> ${UPSTREAM.host}:${UPSTREAM.port}, control on ${LOOPBACK}:${CONTROL_PORT}`
    );
  });
});
