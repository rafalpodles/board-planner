import { createServer as createControl } from "node:http";
import { connect, createServer } from "node:net";

/**
 * Sits between the dev server and MongoDB so a test can take the database away and give it back.
 *
 * The app answers an outage with 503s worded so a client does not discard its credential (BP-362),
 * and nothing in the suite could reach that path: the only database a test can stop is one other
 * sessions on the machine share, and the fixture's own connection has to keep working to seed the
 * next test. So the dev server is pointed here rather than at mongod (playwright.config.ts routes
 * MONGODB_URI through MONGO_PROXY_PORT), while seed() keeps talking to the database directly.
 *
 * A bare TCP pipe. It knows nothing of the wire protocol, which is the point: an outage is every
 * live socket destroyed and every new one accepted and closed at once — a reset, which is what the
 * driver sees when a mongod goes away. POST /outage cuts it, POST /restore lets connections through
 * again.
 *
 * No SIGTERM handler, like the other stubs: a run killed hard leaves this holding both ports, and
 * `reuseExistingServer: false` then stops the next run with "already used" rather than quietly
 * routing it through a proxy left in outage. Clear it with `lsof -ti:<port> | xargs kill`.
 */

// Loopback only, like the other stubs: on a machine several agents share, a control endpoint on
// every interface would let anybody on the network take this run's database away
const LOOPBACK = "127.0.0.1";

const PORT = Number(process.env.MONGO_PROXY_PORT ?? 3991);
const CONTROL_PORT = Number(process.env.MONGO_PROXY_CONTROL_PORT ?? 3992);

const rawUri = process.env.E2E_MONGODB_URI ?? "mongodb://localhost:27017/boardplanner_e2e";
// One host, plain scheme: a host list or an SRV record has no meaning behind a single pipe, and
// the failure would otherwise be 503s from the first test rather than this line. The config makes
// the same check when it rewrites the dev server's URI; this one guards a proxy started by hand.
if (!/^mongodb:\/\/[^,/]+\/[^?]+/.test(rawUri)) {
  console.error(
    "E2E_MONGODB_URI must be a single-host mongodb:// URI naming a database; mongodb+srv and host lists cannot be proxied"
  );
  process.exit(1);
}
const upstream = new URL(rawUri.replace(/^mongodb:\/\//, "http://"));
const UPSTREAM = {
  // The URL parser keeps the brackets on an IPv6 literal; net.connect wants them off
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
  // How many connections the app is holding through here, which is what BP-520 is about: a
  // reconnect that abandons its MongoClient leaves a topology monitor re-establishing on its own
  // heartbeat, and the count climbs one client per outage rather than staying where it started.
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

// The health check answers only once both are listening: a dev server started against a control
// port that was up before the proxy port would fail its first query and read as an outage
proxy.listen(PORT, LOOPBACK, () => {
  control.listen(CONTROL_PORT, LOOPBACK, () => {
    console.log(
      `mongo proxy on ${LOOPBACK}:${PORT} -> ${UPSTREAM.host}:${UPSTREAM.port}, control on ${LOOPBACK}:${CONTROL_PORT}`
    );
  });
});
