import { describe, it, expect } from "vitest";
import { DatabaseUnavailableError, isDatabaseUnreachable } from "./db-errors";

/** An error as the driver hands it over: the name is the only thing matched on. */
function driverError(name: string, message = "boom") {
  return Object.assign(new Error(message), { name });
}

/**
 * The 401/503 split hangs on this one predicate. Answering 401 for an outage told everybody their
 * credential had gone bad, and the browser client clears the session on a 401 — so a database
 * restart signed everyone out, and the sign-in they were sent to failed too (BP-362).
 */
describe("isDatabaseUnreachable", () => {
  it("recognises the wrapper the connection helper throws", () => {
    expect(isDatabaseUnreachable(new DatabaseUnavailableError(new Error("no route to host")))).toBe(
      true
    );
  });

  /**
   * All three shapes a restart takes, measured against a real mongod: the driver has not noticed
   * yet and the QUERY fails with a server-selection error; it has noticed and the reconnect fails;
   * or the command sits in the driver's buffer until it times out. Anything that answers 503 has
   * to recognise all three, or a restart still reads as a credential problem.
   */
  it.each([
    "MongooseServerSelectionError",
    "MongoServerSelectionError",
    "MongoNetworkError",
    "MongoNetworkTimeoutError",
    "MongoNotConnectedError",
    "MongoTopologyClosedError",
    // A request that was mid-operation on the client a reconnect replaced (BP-520).
    "MongoClientClosedError",
  ])("recognises %s", (name) => {
    expect(isDatabaseUnreachable(driverError(name))).toBe(true);
  });

  it("recognises a buffering timeout, which arrives as a plain MongooseError", () => {
    expect(
      isDatabaseUnreachable(
        driverError("MongooseError", "Operation `tasks.find()` buffering timed out after 10000ms")
      )
    ).toBe(true);
  });

  it("matches the buffering message whatever its case", () => {
    expect(isDatabaseUnreachable(driverError("MongooseError", "Buffering Timed Out"))).toBe(true);
  });

  /**
   * Deliberately not everything. A parse error or a rejected password is a deployment that will
   * never come right by being retried, and telling an operator to wait is worse than a 500.
   */
  it.each([
    ["a malformed connection string", driverError("MongoParseError")],
    ["a rejected credential", driverError("MongoServerError", "Authentication failed")],
    ["a bad document", driverError("ValidationError")],
    ["a malformed id", driverError("CastError")],
  ])("does not claim %s means the database is unreachable", (_name, error) => {
    expect(isDatabaseUnreachable(error)).toBe(false);
  });

  // A MongooseError that is not the buffering one stays a 500: the name alone is far too broad
  // to read as an outage.
  it("does not treat every MongooseError as an outage", () => {
    expect(isDatabaseUnreachable(driverError("MongooseError", "something else entirely"))).toBe(
      false
    );
  });

  it.each([
    ["null", null],
    ["undefined", undefined],
    ["a string", "MongoNetworkError"],
    ["an object that merely claims the name", { name: "MongoNetworkError" }],
  ])("answers false for %s, which is not an Error", (_name, value) => {
    expect(isDatabaseUnreachable(value)).toBe(false);
  });
});

describe("DatabaseUnavailableError", () => {
  it("carries the cause and takes its message", () => {
    const cause = new Error("no route to host");
    const wrapped = new DatabaseUnavailableError(cause);

    expect(wrapped.cause).toBe(cause);
    expect(wrapped.message).toBe("no route to host");
    expect(wrapped.name).toBe("DatabaseUnavailableError");
  });

  it("says something sensible when the cause is not an Error", () => {
    expect(new DatabaseUnavailableError("just a string").message).toBe(
      "the database is unreachable"
    );
  });

  /**
   * The module imports nothing — no mongoose, no `./db`. The middleware asks this question inside
   * the catch that has to answer 503, and fifty-odd route tests mock `@/lib/db` with a bare
   * `{ connectDB }`, so an import from a mocked module would fail in the one branch that must work.
   * Matching by name rather than by class is the other half of that: an `instanceof` against a
   * mocked module's class is never true.
   */
  it("recognises a driver error it has never imported the class for", () => {
    class SomeoneElsesMongoNetworkError extends Error {
      name = "MongoNetworkError";
    }

    expect(isDatabaseUnreachable(new SomeoneElsesMongoNetworkError())).toBe(true);
  });
});
