import { createServer } from "node:http";

/**
 * Keeps a stub process alive across a throw, and says loudly what threw.
 *
 * Each stub here is one process for the whole run, so before this an exception inside a request
 * handler exited it and every spec after that point failed on `read ECONNRESET` — wherever the run
 * happened to be, which looks like a different bug each time (BP-575).
 *
 * The guard is not a swallow. A throw answers **500** and prints the request and the stack to
 * stderr, which Playwright pipes into the run output: the spec that made the bad request fails on
 * its own request, and the specs after it keep running against a live stub.
 */

/** Prefixes every line this module prints, so a crash is greppable in a long run log. */
export const CRASH_MARKER = "STUB CRASH";

function report(name, error, req) {
  const where = req ? `${req.method ?? "?"} ${req.url ?? "?"}` : "outside any request";
  const detail = error instanceof Error ? (error.stack ?? error.message) : String(error);
  console.error(`\n${CRASH_MARKER} [${name}] ${where}\n${detail}\n`);
}

/**
 * The request body, as one string. Replaces the `req.on("end", …)` callback the stubs used to
 * parse in: a throw there is not reachable by a try/catch around the handler, which is exactly
 * where `openrouter-stub.mjs` died on a malformed directive.
 */
export function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => resolve(raw));
    req.on("error", reject);
  });
}

/**
 * Wraps a handler so anything it throws — or rejects with, since the handler may be async — is
 * reported and answered rather than thrown at the process.
 */
export function guard(name, handler) {
  return (req, res) => {
    // A client that hangs up mid-write makes the response emit `error`, and an `error` event with
    // no listener is itself an uncaught throw — the crash this guard exists to stop, arriving by
    // the one route a try/catch cannot cover.
    res.on("error", (error) => report(name, error, req));
    Promise.resolve()
      .then(() => handler(req, res))
      .catch((error) => {
        report(name, error, req);
        if (res.headersSent) {
          // Half a reply is already on the wire; there is no status left to send, and the caller
          // has to see a broken response rather than a plausible one.
          res.destroy();
          return;
        }
        res.writeHead(500, { "Content-Type": "text/plain" }).end(`${CRASH_MARKER} ${name}`);
      });
  };
}

let guarding = false;

/**
 * Stops the process exiting on what escapes a handler entirely — a throw from a timer, a rejected
 * promise nobody awaited, a socket error on a server. Logged the same way, because a crash nobody
 * can see is the state this ticket started from.
 */
export function keepAlive(name) {
  if (guarding) return;
  guarding = true;
  process.on("uncaughtException", (error) => report(name, error));
  process.on("unhandledRejection", (reason) => report(name, reason));
}

/**
 * A guarded HTTP stub: `handler` may be async and may throw, and the process survives both.
 *
 * Failing to bind stays fatal. A stub that never listens has nothing to serve, and Playwright's
 * "url not reachable" names that far better than a process sitting up answering nothing.
 */
export function serve({ name, port, host = "127.0.0.1", handler }) {
  keepAlive(name);
  const server = createServer(guard(name, handler));
  let listening = false;
  server.on("error", (error) => {
    if (!listening) {
      report(name, error);
      process.exit(1);
    }
    report(name, error);
  });
  server.listen(port, host, () => {
    listening = true;
    console.log(`${name} listening on ${port}`);
  });
  return server;
}
