import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const connect = vi.fn();
const close = vi.fn();
// `client` rather than the connection's own `close`: the code closes the MongoClient, because
// closing the connection would make mongoose rebuild every model's indexes on the reconnect.
const connection: { readyState: number; client?: { close: typeof close } } = {
  readyState: 1,
  client: { close },
};

vi.mock("mongoose", () => ({ default: { connect, connection } }));

type Db = typeof import("./db");

// The shapes the driver really produces. A plain `new Error("ECONNREFUSED")` is not one of them, and
// a fixture the system never builds cannot tell an outage from a misconfiguration — which is the
// only distinction this file exists to check.
function named(name: string, message: string): Error {
  const error = new Error(message);
  error.name = name;
  return error;
}

const refused = () =>
  named("MongooseServerSelectionError", "connect ECONNREFUSED 127.0.0.1:27017");
const misconfigured = () =>
  named("MongoParseError", 'tls/ssl must be either "true" or "false"');
const bufferingTimedOut = () =>
  named("MongooseError", "Operation `sessions.findOne()` buffering timed out after 10000ms");

async function freshModule(): Promise<Db> {
  vi.resetModules();
  return import("./db");
}

describe("connectDB", () => {
  beforeEach(() => {
    process.env.MONGODB_URI = "mongodb://127.0.0.1:27017/test";
    connect.mockReset();
    close.mockReset();
    close.mockResolvedValue(undefined);
    connection.client = { close };
    connection.readyState = 1;
    delete (globalThis as { mongooseCache?: unknown }).mongooseCache;
  });

  afterEach(() => vi.restoreAllMocks());

  it("reuses one connection across calls", async () => {
    const { connectDB } = await freshModule();
    connect.mockResolvedValue({ ok: true });

    await connectDB();
    await connectDB();

    expect(connect).toHaveBeenCalledTimes(1);
  });

  it("reports an unreachable database as its own failure, carrying the cause", async () => {
    const { connectDB, DatabaseUnavailableError } = await freshModule();
    const cause = refused();
    connect.mockRejectedValue(cause);
    vi.spyOn(console, "error").mockImplementation(() => {});

    const thrown = await connectDB().catch((e) => e);

    expect(thrown).toBeInstanceOf(DatabaseUnavailableError);
    expect(thrown.cause).toBe(cause);
    expect(thrown.message).toBe("connect ECONNREFUSED 127.0.0.1:27017");
  });

  // The bug behind BP-362's second half: the rejected promise stayed in the cache, so it became the
  // answer to every later request. One refused connection — at boot, or a restart of the database —
  // left the instance permanently unable to reach a database that had already come back, and only
  // a redeploy fixed it.
  it("retries after a failure instead of serving the rejection forever", async () => {
    vi.useFakeTimers();
    const { connectDB } = await freshModule();
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    connect.mockRejectedValueOnce(refused()).mockResolvedValue({ ok: true });

    await expect(connectDB()).rejects.toThrow();
    // Past the burst cooldown: within it the answer comes from the last failure by design, which is
    // a different thing from the rejected promise being cached forever
    vi.advanceTimersByTime(1_500);
    await expect(connectDB()).resolves.toEqual({ ok: true });

    expect(connect).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it("names the cause once per outage, not once per request", async () => {
    vi.useFakeTimers();
    const { connectDB } = await freshModule();
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    connect.mockRejectedValue(refused());

    // Spread across the cooldown so these are genuine attempts rather than the burst absorber
    for (let i = 0; i < 5; i++) {
      await connectDB().catch(() => {});
      vi.advanceTimersByTime(1_500);
    }

    expect(error).toHaveBeenCalledTimes(1);
    expect(String(error.mock.calls[0][0])).toContain("MongoDB is unreachable");
    expect(connect).toHaveBeenCalledTimes(5);
    vi.useRealTimers();
  });

  it("says so once when the database comes back", async () => {
    vi.useFakeTimers();
    const { connectDB } = await freshModule();
    vi.spyOn(console, "error").mockImplementation(() => {});
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    connect.mockRejectedValueOnce(refused()).mockResolvedValue({ ok: true });

    await connectDB().catch(() => {});
    vi.advanceTimersByTime(1_500);
    await connectDB();
    await connectDB();

    expect(log.mock.calls.filter((c) => String(c[0]).includes("reachable again"))).toHaveLength(1);
  });

  it("stays quiet on a first connection that works", async () => {
    const { connectDB } = await freshModule();
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    connect.mockResolvedValue({ ok: true });

    await connectDB();

    expect(error).not.toHaveBeenCalled();
    expect(log.mock.calls.filter((c) => String(c[0]).includes("reachable again"))).toHaveLength(0);
  });

  it("still refuses to guess at a missing URI", async () => {
    const { connectDB, DatabaseUnavailableError } = await freshModule();
    delete process.env.MONGODB_URI;

    const thrown = await connectDB().catch((e) => e);

    // Misconfiguration, not an outage: nothing will fix it by being retried, and answering 503
    // would tell an operator to wait for a database that was never named
    expect(thrown).not.toBeInstanceOf(DatabaseUnavailableError);
    expect(thrown.message).toContain("MONGODB_URI");
    expect(connect).not.toHaveBeenCalled();
  });
});

describe("connectDB — a wrong deployment is not an outage", () => {
  beforeEach(() => {
    process.env.MONGODB_URI = "mongodb://127.0.0.1:27017/test";
    connect.mockReset();
    close.mockReset();
    close.mockResolvedValue(undefined);
    connection.client = { close };
    connection.readyState = 1;
    delete (globalThis as { mongooseCache?: unknown }).mongooseCache;
  });

  afterEach(() => vi.restoreAllMocks());

  // Wrapping every rejection made a config typo present as a transient outage: the client retries
  // every few seconds forever, and the one line naming the cause had scrolled away
  it("leaves a configuration fault as itself, so it answers 500 rather than 'retry'", async () => {
    const { connectDB, DatabaseUnavailableError } = await freshModule();
    const cause = misconfigured();
    connect.mockRejectedValue(cause);
    vi.spyOn(console, "error").mockImplementation(() => {});

    const thrown = await connectDB().catch((e) => e);

    expect(thrown).toBe(cause);
    expect(thrown).not.toBeInstanceOf(DatabaseUnavailableError);
  });

  it("says a configuration fault every time, because nothing will fix it by waiting", async () => {
    const { connectDB } = await freshModule();
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    connect.mockRejectedValue(misconfigured());

    for (let i = 0; i < 3; i++) await connectDB().catch(() => {});

    expect(error).toHaveBeenCalledTimes(3);
    expect(String(error.mock.calls[0][0])).toContain("refused the connection as configured");
  });

  it("still retries after one, rather than serving it forever", async () => {
    const { connectDB } = await freshModule();
    vi.spyOn(console, "error").mockImplementation(() => {});
    connect.mockRejectedValueOnce(misconfigured()).mockResolvedValue({ ok: true });

    await expect(connectDB()).rejects.toThrow();
    await expect(connectDB()).resolves.toEqual({ ok: true });
  });

  // Latched, an operator who started reading the log after the first request saw an endless stream
  // of 503s with no cause anywhere
  it("repeats the outage line once the throttle window has passed", async () => {
    vi.useFakeTimers();
    const { connectDB } = await freshModule();
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    connect.mockRejectedValue(refused());

    await connectDB().catch(() => {});
    await connectDB().catch(() => {});
    expect(error).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(61_000);
    await connectDB().catch(() => {});

    expect(error).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });
});

describe("isDatabaseUnreachable", () => {
  it("recognises the failure a database that died mid-connection produces", async () => {
    const { isDatabaseUnreachable } = await freshModule();

    // The common shape, and the one connectDB never sees: mongoose reports readyState 2 while it
    // reconnects, so the cached connection is handed back and the *query* is what fails
    expect(isDatabaseUnreachable(bufferingTimedOut())).toBe(true);
  });

  it("recognises the driver's network and selection errors", async () => {
    const { isDatabaseUnreachable } = await freshModule();

    for (const name of [
      "MongooseServerSelectionError",
      "MongoServerSelectionError",
      "MongoNetworkError",
      "MongoNetworkTimeoutError",
      "MongoNotConnectedError",
      "MongoTopologyClosedError",
    ]) {
      expect(isDatabaseUnreachable(named(name, "boom"))).toBe(true);
    }
  });

  it("recognises its own wrapper", async () => {
    const { isDatabaseUnreachable, DatabaseUnavailableError } = await freshModule();

    expect(isDatabaseUnreachable(new DatabaseUnavailableError(refused()))).toBe(true);
  });

  it("does not answer for a misconfiguration, a bug, or a non-error", async () => {
    const { isDatabaseUnreachable } = await freshModule();

    expect(isDatabaseUnreachable(misconfigured())).toBe(false);
    expect(isDatabaseUnreachable(named("MongoServerError", "Authentication failed."))).toBe(false);
    expect(isDatabaseUnreachable(new TypeError("cannot read properties of undefined"))).toBe(false);
    expect(isDatabaseUnreachable(named("MongooseError", "Cast to ObjectId failed"))).toBe(false);
    expect(isDatabaseUnreachable("a string")).toBe(false);
    expect(isDatabaseUnreachable(undefined)).toBe(false);
  });
});

describe("connectDB — the state the tests could not see", () => {
  beforeEach(() => {
    process.env.MONGODB_URI = "mongodb://127.0.0.1:27017/test";
    connect.mockReset();
    close.mockReset();
    close.mockResolvedValue(undefined);
    connection.client = { close };
    connection.readyState = 1;
    delete (globalThis as { mongooseCache?: unknown }).mongooseCache;
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  // Never once executed by a test before: readyState was pinned to 1 in every setup, so the branch
  // that throws away a cached connection was dead code as far as the suite was concerned
  it("drops a cached connection the driver has given up on, and connects again", async () => {
    const { connectDB } = await freshModule();
    connect.mockResolvedValue({ ok: true });

    await connectDB();
    expect(connect).toHaveBeenCalledTimes(1);

    connection.readyState = 0;
    await connectDB();

    expect(connect).toHaveBeenCalledTimes(2);
  });

  it("bounds the wait instead of taking the driver's 30 s default", async () => {
    const { connectDB } = await freshModule();
    connect.mockResolvedValue({ ok: true });

    await connectDB();

    expect(connect).toHaveBeenCalledWith(
      "mongodb://127.0.0.1:27017/test",
      expect.objectContaining({ serverSelectionTimeoutMS: 5_000 })
    );
  });

  // Without the cooldown each request in a burst pays the connect timeout in full — the price of no
  // longer serving a cached rejection, which is worth paying once and not eight times
  it("answers a burst from one attempt rather than attempting per request", async () => {
    vi.useFakeTimers();
    const { connectDB } = await freshModule();
    vi.spyOn(console, "error").mockImplementation(() => {});
    connect.mockRejectedValue(refused());

    await connectDB().catch(() => {});
    await Promise.all([connectDB().catch(() => {}), connectDB().catch(() => {})]);

    expect(connect).toHaveBeenCalledTimes(1);
  });

  it("tries again once the cooldown has passed", async () => {
    vi.useFakeTimers();
    const { connectDB } = await freshModule();
    vi.spyOn(console, "error").mockImplementation(() => {});
    connect.mockRejectedValue(refused());

    await connectDB().catch(() => {});
    vi.advanceTimersByTime(1_500);
    await connectDB().catch(() => {});

    expect(connect).toHaveBeenCalledTimes(2);
  });

  it("still reports the cooldown refusal as an outage, not as a bad credential", async () => {
    vi.useFakeTimers();
    const { connectDB, DatabaseUnavailableError, isDatabaseUnreachable } = await freshModule();
    vi.spyOn(console, "error").mockImplementation(() => {});
    connect.mockRejectedValue(refused());

    await connectDB().catch(() => {});
    const thrown = await connectDB().catch((e) => e);

    expect(thrown).toBeInstanceOf(DatabaseUnavailableError);
    expect(isDatabaseUnreachable(thrown)).toBe(true);
  });

  // The flag used to be module-local while the cache it describes was on global, so one outage was
  // announced twice and the next went unlogged from the instance that saw it
  it("keeps its outage bookkeeping with the connection, across module instances", async () => {
    const first = await freshModule();
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    connect.mockRejectedValue(refused());

    await first.connectDB().catch(() => {});
    expect(error).toHaveBeenCalledTimes(1);

    // A second instance of the module — instrumentation's graph is not a route's, and a dev reload
    // makes a third — sharing the one cache on global
    const second = await freshModule();
    await second.connectDB().catch(() => {});
    expect(error).toHaveBeenCalledTimes(1);

    connect.mockReset();
    connect.mockResolvedValue({ ok: true });
    connection.readyState = 1;
    vi.useFakeTimers();
    vi.advanceTimersByTime(1_500);
    await second.connectDB();

    expect(log.mock.calls.filter((c) => String(c[0]).includes("reachable again"))).toHaveLength(1);
  });
});

// The client a reconnect leaves behind. `mongoose.connect` assigns its MongoClient to the
// connection before awaiting `connect()`, and the next call overwrites that reference — so an
// outage/restore cycle used to strand two clients, each with a topology monitor still polling.
describe("connectDB — the client a reconnect abandons", () => {
  beforeEach(() => {
    process.env.MONGODB_URI = "mongodb://127.0.0.1:27017/test";
    connect.mockReset();
    close.mockReset();
    close.mockResolvedValue(undefined);
    connection.client = { close };
    connection.readyState = 1;
    delete (globalThis as { mongooseCache?: unknown }).mongooseCache;
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("closes the connection it gave up on before opening another", async () => {
    const order: string[] = [];
    close.mockImplementation(async () => void order.push("close"));
    connect.mockImplementation(async () => {
      order.push("connect");
      return { ok: true };
    });
    const { connectDB } = await freshModule();

    await connectDB();
    connection.readyState = 0;
    await connectDB();

    expect(order).toEqual(["connect", "close", "connect"]);
  });

  it("closes the client an attempt that never connected left behind", async () => {
    const { connectDB } = await freshModule();
    vi.spyOn(console, "error").mockImplementation(() => {});
    connect.mockRejectedValue(refused());

    await connectDB().catch(() => {});

    expect(close).toHaveBeenCalledTimes(1);
  });

  // A rejected password is a configuration fault, and unlike a malformed URI it fails at
  // `client.connect()` — after the client exists. `new MongoClient` throwing takes the other
  // branch, where there is nothing to close and `connection.client` is undefined.
  it("closes the client a rejected credential left behind", async () => {
    const { connectDB } = await freshModule();
    vi.spyOn(console, "error").mockImplementation(() => {});
    connect.mockRejectedValue(named("MongoServerError", "Authentication failed."));

    await connectDB().catch(() => {});

    expect(close).toHaveBeenCalledTimes(1);
  });

  it("survives a fault that never built a client at all", async () => {
    const { connectDB } = await freshModule();
    vi.spyOn(console, "error").mockImplementation(() => {});
    connect.mockRejectedValue(misconfigured());
    connection.client = undefined;

    const thrown = await connectDB().catch((e) => e);

    expect(thrown.name).toBe("MongoParseError");
    expect(close).not.toHaveBeenCalled();
  });

  // The control: a healthy connection is handed back, and closing the client under it would end
  // every request the process had left
  it("closes nothing while the connection is the one in use", async () => {
    const { connectDB } = await freshModule();
    connect.mockResolvedValue({ ok: true });

    await connectDB();
    await connectDB();
    await connectDB();

    expect(close).not.toHaveBeenCalled();
  });

  // Both branches await the close, so a close that throws would carry the request off the path
  // that wraps the outage and nulls the cached promise — and the rejected promise then becomes the
  // answer to every later request, which is the BP-362 wedge returning through this change
  it("still answers an outage as an outage when the close of the dead client fails", async () => {
    const { connectDB, DatabaseUnavailableError } = await freshModule();
    vi.spyOn(console, "error").mockImplementation(() => {});
    connect.mockRejectedValue(refused());
    close.mockRejectedValue(new Error("topology already closed"));

    const thrown = await connectDB().catch((e) => e);

    expect(thrown).toBeInstanceOf(DatabaseUnavailableError);
    expect(
      (globalThis as { mongooseCache?: { promise: unknown } }).mongooseCache?.promise
    ).toBeNull();
  });

  it("reports a reconnect that fails as an outage, not as a connection", async () => {
    vi.useFakeTimers();
    const { connectDB, DatabaseUnavailableError } = await freshModule();
    vi.spyOn(console, "error").mockImplementation(() => {});
    connect.mockResolvedValueOnce({ ok: true }).mockRejectedValue(refused());

    await connectDB();
    connection.readyState = 0;
    const thrown = await connectDB().catch((e) => e);

    expect(thrown).toBeInstanceOf(DatabaseUnavailableError);
    expect(
      (globalThis as { mongooseCache?: { promise: unknown } }).mongooseCache?.promise
    ).toBeNull();
    // And the next request tries again rather than being served the rejection
    vi.advanceTimersByTime(1_500);
    connect.mockResolvedValue({ ok: true });
    await expect(connectDB()).resolves.toEqual({ ok: true });
  });

  it("reconnects even when the close fails, rather than answering with that failure", async () => {
    const { connectDB } = await freshModule();
    connect.mockResolvedValue({ ok: true });
    close.mockRejectedValue(new Error("topology already closed"));

    await connectDB();
    connection.readyState = 0;

    await expect(connectDB()).resolves.toEqual({ ok: true });
    expect(connect).toHaveBeenCalledTimes(2);
  });

  // A second caller arriving while the close is in flight must not have the client it just opened
  // closed underneath it — which is why the close is the first step of the reconnect rather than
  // something awaited before the cache is refilled
  it("does not open a client while the close of the last one is still in flight", async () => {
    const order: string[] = [];
    let releaseClose: () => void = () => {};
    close.mockImplementation(() => {
      order.push("close starts");
      return new Promise<void>((resolve) => {
        releaseClose = () => {
          order.push("close ends");
          resolve();
        };
      });
    });
    connect.mockImplementation(async () => {
      order.push("connect");
      connection.readyState = 1;
      return { ok: true };
    });
    const { connectDB } = await freshModule();

    await connectDB();
    connection.readyState = 0;

    const first = connectDB();
    const second = connectDB();
    await Promise.resolve();
    await Promise.resolve();
    releaseClose();

    await expect(first).resolves.toEqual({ ok: true });
    await expect(second).resolves.toEqual({ ok: true });
    // The second caller waits for the reconnect the first one started. Emptying the cache and
    // awaiting the close instead lets it open a client of its own — "connect" between the two close
    // lines — which is the client the in-flight close then takes with it.
    expect(order).toEqual(["connect", "close starts", "close ends", "connect"]);
    expect(close).toHaveBeenCalledTimes(1);
  });
});
