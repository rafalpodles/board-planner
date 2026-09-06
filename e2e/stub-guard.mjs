import { writeSync } from "node:fs";
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
  // Synchronously, not through console.error: a write to a pipe is asynchronous on POSIX, and the
  // one report that matters most is the one followed immediately by process.exit.
  writeSync(2, `\n${CRASH_MARKER} [${name}] ${where}\n${detail}\n`);
}

/**
 * The request body, as one string.
 *
 * Replaces the `req.on("end", …)` callback the stubs used to parse in: a throw there is not
 * reachable by a try/catch around the handler, which is exactly where `openrouter-stub.mjs` died
 * on a malformed directive.
 *
 * `setEncoding` rather than concatenating chunks: a multi-byte character split across two of them
 * decodes to a pair of replacement characters otherwise, and the PM chat box is typed into in
 * Polish.
 */
export function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.setEncoding("utf8");
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
    // An `error` event with no listener throws, and a response can emit one after the handler has
    // returned — past anything a catch could hold. Handled here rather than left to `keepAlive`
    // so a hung-up client is reported as what it is instead of as a process-level crash.
    res.on("error", (error) => report(name, error, req));
    Promise.resolve()
      .then(() => handler(req, res))
      .catch((error) => {
        report(name, error, req);
        if (res.headersSent) {
          // Half a reply is already on the wire; there is no status left to send, so the reply is
          // abandoned unfinished rather than completed into something that reads as an answer.
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
 * promise nobody awaited. Logged the same way, because a crash nobody can see is the state this
 * ticket started from.
 */
export function keepAlive(name) {
  if (guarding) return;
  guarding = true;
  process.on("uncaughtException", (error) => report(name, error));
  process.on("unhandledRejection", (reason) => report(name, reason));
}

/**
 * Makes a failure to bind fatal, which `keepAlive` would otherwise swallow into a clean exit or a
 * process hanging on to a port it never serves.
 *
 * A stub that cannot listen has nothing to serve, and Playwright's "url not reachable" names that
 * far better than a process sitting up answering nothing. Every server a stub listens on needs
 * this, including the ones that do not go through `serve` (BP-575 review).
 */
export function fatalOnListenFailure(name, server) {
  let listening = false;
  server.on("listening", () => (listening = true));
  server.on("error", (error) => {
    report(name, error);
    if (!listening) process.exit(1);
  });
  return server;
}

/** A guarded HTTP stub: `handler` may be async and may throw, and the process survives both. */
export function serve({ name, port, host = "127.0.0.1", handler }) {
  keepAlive(name);
  const server = fatalOnListenFailure(name, createServer(guard(name, handler)));
  server.listen(port, host, () => console.log(`${name} listening on ${port}`));
  return server;
}
