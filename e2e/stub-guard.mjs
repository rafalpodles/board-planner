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

/**
 * Puts a line on stderr, whole, without ever becoming the failure itself.
 *
 * Synchronously rather than through console.error, because a write to a pipe is asynchronous on
 * POSIX and the report that matters most is the one followed immediately by `process.exit`. Two
 * things that costs, both measured rather than reasoned about:
 *
 * - `writeSync` does not loop. On a pipe it returns a short count at the 64 KB buffer and drops
 *   the rest in silence, so the write is repeated from where it stopped.
 * - Once anything has touched `process.stderr`, libuv leaves the fd non-blocking, and a full pipe
 *   then makes `writeSync` **throw** EAGAIN. Thrown from here that is fatal in the worst possible
 *   place: this function is what the `uncaughtException` handler calls, and a throw inside that
 *   handler ends the process — the exact death this module exists to prevent. So nothing escapes;
 *   what could not be written synchronously is handed to the stream's own queue, which costs the
 *   synchrony and delivers it only if the process lives long enough to drain — see `fatal`.
 *
 * The re-entrancy guard is not belt and braces. With fd 2 unwritable, the fallback's `write` emits
 * `error` on a stream nobody listens to, Node raises that as an uncaught exception, and the
 * handler calls back into here: measured at 127,832 rounds in five seconds, RSS climbing, the stub
 * alive and serving nothing. A stub spinning at 100% is worse for a run than one that died fast.
 */
let emitting = false;

function emit(text) {
  if (emitting) return;
  emitting = true;
  try {
    const buffer = Buffer.from(text, "utf8");
    let written = 0;
    while (written < buffer.length) {
      let sent = 0;
      try {
        sent = writeSync(2, buffer, written, buffer.length - written);
      } catch {
        // Never let the queued write's own `error` event become an uncaught exception.
        if (process.stderr.listenerCount("error") === 0) process.stderr.on("error", () => {});
        try {
          process.stderr.write(buffer.subarray(written));
        } catch {
          // Nothing left to try. A report nobody reads is bad; a crash caused by reporting is worse.
        }
        return;
      }
      // A zero-length write is not progress, and looping on it wedges the event loop — which is
      // this function failing in the one way its whole point is to avoid.
      if (sent <= 0) return;
      written += sent;
    }
  } catch {
    // Buffer.from itself, on a stack too long to hold. Nothing this function does may throw.
  } finally {
    emitting = false;
  }
}

function report(name, error, req) {
  const where = req ? `${req.method ?? "?"} ${req.url ?? "?"}` : "outside any request";
  const detail = error instanceof Error ? (error.stack ?? error.message) : String(error);
  emit(`\n${CRASH_MARKER} [${name}] ${where}\n${detail}\n`);
}

/**
 * A refusal the stub cannot serve past — reported the same way, then fatal.
 *
 * `process.exit` discards whatever `emit` had to queue, so the exit waits for the stream instead
 * of racing it: measured, a `fatal` behind a full pipe lost its entire message that way. The timer
 * is unreferenced, so a pipe nobody drains ends the process on the exit code rather than hanging.
 */
export function fatal(name, message) {
  emit(`\n${CRASH_MARKER} [${name}] outside any request\n${message}\n`);
  process.exitCode = 1;
  if (process.stderr.writableLength === 0) process.exit(1);
  process.stderr.write("", () => process.exit(1));
  setTimeout(() => process.exit(1), 1_000).unref();
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
 *
 * One listener, not two. Node raises an unhandled rejection as an uncaught exception under its
 * default mode, so an `unhandledRejection` listener beside this one changes nothing under any
 * setting this suite runs with — it was written, found unpinnable by mutation, and removed rather
 * than left as a line nobody can redden. Only `--unhandled-rejections=warn` tells them apart, and
 * nothing here sets it (BP-575 round-two review).
 */
export function keepAlive(name) {
  if (guarding) return;
  guarding = true;
  process.on("uncaughtException", (error) => report(name, error));
}

/**
 * Makes a failure to bind fatal, which `keepAlive` would otherwise swallow into a clean exit or a
 * process hanging on to a port it never serves.
 *
 * A stub that cannot listen has nothing to serve, and Playwright's "url not reachable" names that
 * far better than a process sitting up answering nothing. Every server a stub listens on needs
 * this, including the ones that do not go through `serve` (BP-575 review).
 *
 * Only *before* listening, though. An error after that — an accept failure, EMFILE — is reported
 * and survived, because killing the stub over one refused connection is the whole bug again.
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
