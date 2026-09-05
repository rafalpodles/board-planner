/**
 * Telling "the database is not answering" from "this request was wrong" — and from "this deployment
 * is wrong".
 *
 * Kept out of db.ts, and free of any mongoose import, because 50-odd route tests mock `@/lib/db`
 * with a bare `{ connectDB }`. The middleware asks this question inside the catch that has to answer
 * 503, so an import from a mocked module would fail exactly there, in the one branch that must work.
 */
/**
 * The database could not be reached — which is not the same as anything the caller did wrong.
 *
 * It exists so the auth middleware can tell "I cannot resolve this session" from "I resolved it and
 * it is not valid". Answering 401 for both told everyone their credential had gone bad during an
 * outage, and the browser client clears the session on a 401, so an outage signed people out
 * (BP-362).
 */
export class DatabaseUnavailableError extends Error {
  constructor(readonly cause: unknown) {
    super(cause instanceof Error ? cause.message : "the database is unreachable");
    this.name = "DatabaseUnavailableError";
  }
}

// Failures that mean "the database is not answering right now", as opposed to "this deployment is
// wrong". Matched by name rather than by class: these come from two packages (mongoose and the
// driver) whose error hierarchies are wide, and half the callers here mock `./db` in tests, which
// would make an identity check fail in the one branch that has to work.
const UNREACHABLE_ERRORS = new Set([
  "MongooseServerSelectionError",
  "MongoServerSelectionError",
  "MongoNetworkError",
  "MongoNetworkTimeoutError",
  "MongoNotConnectedError",
  "MongoTopologyClosedError",
  // A request that was mid-operation on the client a reconnect replaced. It is the database going
  // away, seen from a request that had already started — 503 with a Retry-After, not a 500 (BP-520)
  "MongoClientClosedError",
]);

/**
 * True when this error means the database could not be reached — including the shape it takes when
 * the connection was established and the database went away afterwards.
 *
 * That second case is the common one and it does NOT come from `connectDB`. Measured against a real
 * mongod: for about two seconds after the database goes away, `readyState` still reads 1 — the
 * driver has not noticed — so the cached connection is handed back and the *query* is what fails,
 * with a server-selection error. Once the driver does notice, `readyState` is 0 and the next call
 * reconnects, which fails at connect time instead. Later still, a query can time out against the
 * driver's command buffer. Anything that answers 503 has to recognise all three, or a database
 * restart still reads as a credential problem — which on /api/mcp meant `invalid_token` and a
 * client discarding a working token (BP-362 review).
 *
 * Deliberately not everything: a `MongoParseError` or a rejected password is a deployment that will
 * never come right by being retried, and telling an operator to wait is worse than a 500.
 */
export function isDatabaseUnreachable(err: unknown): boolean {
  if (err instanceof DatabaseUnavailableError) return true;
  if (!(err instanceof Error)) return false;
  if (UNREACHABLE_ERRORS.has(err.name)) return true;
  return err.name === "MongooseError" && /buffering timed out/i.test(err.message);
}
