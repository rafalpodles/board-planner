import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const connect = vi.fn();
const close = vi.fn();
const connection: {
  readyState: number;
  client?: { close: () => Promise<void> };
  getClient: () => { close: () => Promise<void> } | undefined;
} = {
  readyState: 1,
  client: { close },
  getClient: () => connection.client,
};

vi.mock("mongoose", () => ({ default: { connect, connection } }));

type Db = typeof import("./db");

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

  it("retries after a failure instead of serving the rejection forever", async () => {
    vi.useFakeTimers();
    const { connectDB } = await freshModule();
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    connect.mockRejectedValueOnce(refused()).mockResolvedValue({ ok: true });

    await expect(connectDB()).rejects.toThrow();
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
      "MongoClientClosedError",
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

  it("keeps its outage bookkeeping with the connection, across module instances", async () => {
    const first = await freshModule();
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    connect.mockRejectedValue(refused());

    await first.connectDB().catch(() => {});
    expect(error).toHaveBeenCalledTimes(1);

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

  it("closes the one it gave up on, once the replacement has been opened", async () => {
    const clients: { close: ReturnType<typeof vi.fn> }[] = [];
    const order: string[] = [];
    connect.mockImplementation(async () => {
      const client = {
        close: vi.fn(async () => void order.push(`close #${clients.indexOf(client)}`)),
      };
      clients.push(client);
      connection.client = client;
      order.push(`connect #${clients.indexOf(client)}`);
      return { ok: true };
    });
    const { connectDB } = await freshModule();

    await connectDB();
    connection.readyState = 0;
    await connectDB();

    expect(order).toEqual(["connect #0", "connect #1", "close #0"]);
    expect(clients[1].close).not.toHaveBeenCalled();
  });

  it("does not close the client the reconnect handed back", async () => {
    const { connectDB } = await freshModule();
    connect.mockImplementation(async () => {
      connection.readyState = 1;
      return { ok: true };
    });

    await connectDB();
    connection.readyState = 0;
    await connectDB();

    expect(close).not.toHaveBeenCalled();
  });

  it("closes it even when the replacement could not be opened", async () => {
    vi.useFakeTimers();
    const abandoned = { close };
    connection.client = abandoned;
    const { connectDB } = await freshModule();
    vi.spyOn(console, "error").mockImplementation(() => {});
    connect
      .mockResolvedValueOnce({ ok: true })
      .mockImplementation(async () => {
        connection.client = { close: vi.fn() };
        throw refused();
      });

    await connectDB();
    connection.readyState = 0;
    await connectDB().catch(() => {});

    expect(close).toHaveBeenCalledTimes(1);
  });

  it("closes nothing while the connection is the one in use", async () => {
    const { connectDB } = await freshModule();
    connect.mockResolvedValue({ ok: true });

    await connectDB();
    await connectDB();
    await connectDB();

    expect(close).not.toHaveBeenCalled();
  });

  it("closes nothing when a connect fails with no connection to replace", async () => {
    const { connectDB } = await freshModule();
    vi.spyOn(console, "error").mockImplementation(() => {});
    connect.mockRejectedValue(refused());

    await connectDB().catch(() => {});

    expect(close).not.toHaveBeenCalled();
  });

  it("reconnects even when the close fails, rather than answering with that failure", async () => {
    connect.mockImplementation(async () => {
      connection.client = {
        close: vi.fn(async () => {
          throw new Error("topology already closed");
        }),
      };
      return { ok: true };
    });
    const { connectDB } = await freshModule();

    await connectDB();
    connection.readyState = 0;

    await expect(connectDB()).resolves.toEqual({ ok: true });
    expect(connect).toHaveBeenCalledTimes(2);
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
    vi.advanceTimersByTime(1_500);
    connect.mockResolvedValue({ ok: true });
    await expect(connectDB()).resolves.toEqual({ ok: true });
  });

  it("does not open a client while the close of the last one is still in flight", async () => {
    const order: string[] = [];
    connect.mockImplementation(async () => {
      order.push("connect");
      connection.client = { close };
      return { ok: true };
    });
    close.mockImplementation(async () => void order.push("close"));
    const { connectDB } = await freshModule();

    await connectDB();
    connection.readyState = 0;

    const first = connectDB();
    const second = connectDB();

    await expect(first).resolves.toEqual({ ok: true });
    await expect(second).resolves.toEqual({ ok: true });
    expect(order).toEqual(["connect", "connect", "close"]);
  });
});
