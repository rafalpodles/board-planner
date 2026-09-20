import mongoose from "mongoose";
import type { MongoClient } from "mongodb";
import { DatabaseUnavailableError, isDatabaseUnreachable } from "./db-errors";

// Re-exported for the callers that already reach for them here
export { DatabaseUnavailableError, isDatabaseUnreachable };

interface MongooseCache {
  conn: typeof mongoose | null;
  promise: Promise<typeof mongoose> | null;
  /**
   * Outage bookkeeping lives here, with the connection it describes, rather than in a module
   * variable. Next duplicates module instances — the instrumentation graph that owns the PM
   * scheduler is not the one a route runs in, and a dev hot reload makes a third — and a
   * module-local flag meant one outage was announced twice while the next went unlogged from the
   * instance that saw it (BP-362 review).
   */
  reportedAt: number | null;
  /** When the last attempt failed, so a burst does not each pay the connect timeout. */
  failedAt: number | null;
  /**
   * The in-flight confirmation ping from isReallyDisconnected, shared the same way `promise` is.
   * Awaiting it is not synchronous, so without a shared slot every caller in a burst would start
   * its own ping and, seeing it resolve true, its own reset-and-reconnect — the same overshoot
   * BP-719 fixed elsewhere in this codebase, here on a MongoClient instead of a document array.
   */
  staleCheck: Promise<boolean> | null;
}

declare global {
  // eslint-disable-next-line no-var
  var mongooseCache: MongooseCache | undefined;
}

// Latching this for the whole outage told an operator who started reading the log later exactly
// nothing: they saw an endless stream of 503s with the cause printed once, long before they looked.
// Throttled by time instead, so the reason stays discoverable without one line per request.
const OUTAGE_LOG_INTERVAL_MS = 60_000;

// The driver's default server-selection timeout is 30 s, and since a failed connection is no longer
// cached every request would pay it in full — where before the fix they were answered instantly and
// wrongly. Lined up with the Retry-After the 503 carries.
const SERVER_SELECTION_TIMEOUT_MS = 5_000;

// Bounds a request already dispatched on a socket that looks live but never answers — a hung mongod
// or a stalled network path, as opposed to a closed socket, which serverSelectionTimeoutMS above
// already covers. The driver has no timeout here by default, which measured 36.5 s on a suspended
// (not killed) proxy — the socket stays open and nothing replies (BP-366).
//
// Chosen against a measurement, not a guess: this app's heaviest real aggregations (the two under
// /stats, the per-sprint rollup that runs on the board's poll) timed against 100,000 seeded tasks in
// one project — far more than any project on this instance holds — on a local mongo:4.4 with no
// other load. The slowest, the sprint rollup, took ~1.0 s; the rest well under that. 15 s leaves
// roughly 15x headroom above that ceiling while still cutting the worst case by more than half.
// Local and unloaded, not a production trace, so the margin is deliberately generous rather than
// tight against the measured number.
const SOCKET_TIMEOUT_MS = 15_000;

// Inside this window a further attempt is not made at all: one caller pays the timeout and the rest
// of the burst is answered from that. Short on purpose — this is a burst absorber, not the cache
// whose permanence was the bug.
const FAILURE_COOLDOWN_MS = 1_000;

// How long a caller waits for the confirmation ping below before giving up on it and treating the
// connection as genuinely gone. Deliberately much shorter than SOCKET_TIMEOUT_MS: this only needs to
// outlast the moment the event loop is busy, not a real query, and a caller stuck behind a truly dead
// socket should reach the ordinary reconnect-and-fail path quickly rather than wait out that bound
// twice over.
const STALE_CHECK_TIMEOUT_MS = 2_000;

/**
 * Let go of a MongoClient the connection has replaced.
 *
 * `mongoose.connect` assigns its client to the connection *before* awaiting `client.connect()` and
 * the next call overwrites that reference, so a connection the database went away under leaves a
 * client nobody holds with its topology monitor still polling. Measured against a real mongod:
 * without this, six outage/restore cycles took the connections through the proxy from 2 to 13.
 *
 * The client rather than `mongoose.connection.close()`, which deletes every model's `$init` and
 * makes the reconnect re-run `createCollection` and `createIndexes` for all of them.
 *
 * Never the client the connection ended up with: `openUri` hands back the existing one when the
 * monitor has meanwhile marked the server usable again, and closing that is closing the live one.
 */
async function releaseAbandonedClient(client: MongoClient | undefined): Promise<void> {
  if (!client || client === mongoose.connection.getClient()) return;
  try {
    await client.close();
  } catch {
    // The client is being thrown away either way; a failure to close it is not the caller's problem
    // and must not become the answer to a request that only wanted a connection.
  }
}

function openConnection(uri: string): Promise<typeof mongoose> {
  return mongoose.connect(uri, {
    serverSelectionTimeoutMS: SERVER_SELECTION_TIMEOUT_MS,
    socketTimeoutMS: SOCKET_TIMEOUT_MS,
  });
}

/**
 * `readyState` synthesises disconnected whenever no heartbeat has landed in 2 x
 * heartbeatFrequencyMS — mongoose's own fallback for "the process was frozen, not the server"
 * (its connection.js names a frozen AWS Lambda container as the case it is for). A blocked event
 * loop here — a long aggregation, a PM turn — starves the driver's heartbeat timer the same way:
 * measured, a query still succeeded on a connection whose readyState had already read 0 for a
 * full minute. Confirmed with a ping bounded by its own short timeout, never the connection's
 * SOCKET_TIMEOUT_MS — a caller behind a truly dead socket must not wait out that bound twice
 * before the ordinary reconnect-and-fail path even starts (BP-366).
 *
 * On purpose, not handled: the synthesis above reads the client's topology description and
 * explicitly skips LoadBalanced (no heartbeats there to be stale), and this instance only ever
 * runs standalone (topology Single — docker-compose.yml is explicit that this is also why the app
 * stays on 4.4). A deployment behind a load balancer or a sharded cluster would need this re-checked
 * rather than assumed.
 */
async function isReallyDisconnected(client: MongoClient): Promise<boolean> {
  try {
    await Promise.race([
      client.db().command({ ping: 1 }),
      new Promise((_, reject) => {
        setTimeout(() => reject(new Error("stale-connection check timed out")), STALE_CHECK_TIMEOUT_MS);
      }),
    ]);
    return false;
  } catch {
    return true;
  }
}

export async function connectDB(): Promise<typeof mongoose> {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    throw new Error("MONGODB_URI environment variable is not defined");
  }

  const cached: MongooseCache = global.mongooseCache ?? {
    conn: null,
    promise: null,
    reportedAt: null,
    failedAt: null,
    staleCheck: null,
  };

  if (!global.mongooseCache) {
    global.mongooseCache = cached;
  }

  // Reset cache if connection was lost — unless a quick ping shows readyState lied: see
  // isReallyDisconnected above.
  //
  // The check is async, so the decision it feeds cannot be made synchronously the way `promise`'s
  // own claim below is — a burst arriving while one ping is in flight must share it rather than
  // each start their own, or each would see readyState still 0 and each begin its own reset. The
  // shared `staleCheck` slot is claimed the same way `promise` is: synchronously, before anything
  // here is awaited.
  if (cached.conn && mongoose.connection.readyState === 0) {
    if (!cached.staleCheck) {
      const client = mongoose.connection.getClient();
      cached.staleCheck = client ? isReallyDisconnected(client) : Promise.resolve(true);
    }
    const staleCheck = cached.staleCheck;

    // A sibling that awaited the same check may already have reset (or reconnected) by the time
    // this resolves — `cached.conn` says which is still true.
    if ((await staleCheck) && cached.conn) {
      cached.conn = null;
      // The old client is released after the replacement has been attempted, not before it.
      // readyState 0 says the driver marked the server unknown, not that the client is dead — it
      // goes on answering queries for seconds afterwards — so closing it first kills the requests
      // already holding it, and does so while nothing else is connected yet.
      const abandoned = mongoose.connection.getClient();
      cached.promise = openConnection(uri).finally(() => releaseAbandonedClient(abandoned));
    }
    if (cached.staleCheck === staleCheck) {
      cached.staleCheck = null;
    }
  }

  if (cached.conn) {
    return cached.conn;
  }

  if (
    !cached.promise &&
    cached.failedAt !== null &&
    Date.now() - cached.failedAt < FAILURE_COOLDOWN_MS
  ) {
    throw new DatabaseUnavailableError(new Error("the database was unreachable a moment ago"));
  }

  if (!cached.promise) {
    cached.promise = openConnection(uri);
  }

  try {
    cached.conn = await cached.promise;
    cached.failedAt = null;
    if (cached.reportedAt !== null) {
      console.log("MongoDB is reachable again");
      cached.reportedAt = null;
    }
  } catch (err) {
    const unreachable = isDatabaseUnreachable(err);
    const detail = err instanceof Error ? err.message : err;

    if (!unreachable) {
      // A deployment fault: it will not come right on its own, so it is said every time and left to
      // answer 500 rather than being dressed up as an outage somebody should wait out
      cached.promise = null;
      console.error("MongoDB refused the connection as configured:", detail);
      throw err;
    }

    cached.failedAt = Date.now();

    // Not once per request — every route calls this, and one line each buries the cause under the
    // symptom at exactly the moment somebody is reading the log to find it
    if (cached.reportedAt === null || Date.now() - cached.reportedAt >= OUTAGE_LOG_INTERVAL_MS) {
      cached.reportedAt = Date.now();
      console.error(
        "MongoDB is unreachable — requests needing it will answer 503 until it returns:",
        detail
      );
    }
    // Drop the rejected promise, or it is the answer to every request from here on. The reset above
    // cannot do it: it needs `cached.conn`, which a connection that never succeeded does not have —
    // so one refused connection at boot used to make the instance permanently unable to reach a
    // database that had since come back, and only a redeploy fixed it. That is also what made
    // "route handlers reconnect lazily" untrue, which is the reason instrumentation.ts is allowed
    // to log a boot-time failure and carry on (BP-362).
    cached.promise = null;
    throw new DatabaseUnavailableError(err);
  }
  return cached.conn;
}
