import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const connect = vi.fn();
const connection = { readyState: 1 };

vi.mock("mongoose", () => ({ default: { connect, connection } }));

type Db = typeof import("./db");

async function freshModule(): Promise<Db> {
  vi.resetModules();
  return import("./db");
}

describe("connectDB", () => {
  beforeEach(() => {
    process.env.MONGODB_URI = "mongodb://127.0.0.1:27017/test";
    connect.mockReset();
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
    const cause = new Error("connect ECONNREFUSED 127.0.0.1:27017");
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
    const { connectDB } = await freshModule();
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    connect.mockRejectedValueOnce(new Error("down")).mockResolvedValue({ ok: true });

    await expect(connectDB()).rejects.toThrow();
    await expect(connectDB()).resolves.toEqual({ ok: true });

    expect(connect).toHaveBeenCalledTimes(2);
  });

  it("names the cause once per outage, not once per request", async () => {
    const { connectDB } = await freshModule();
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    connect.mockRejectedValue(new Error("down"));

    for (let i = 0; i < 5; i++) await connectDB().catch(() => {});

    expect(error).toHaveBeenCalledTimes(1);
    expect(String(error.mock.calls[0][0])).toContain("MongoDB is unreachable");
    expect(connect).toHaveBeenCalledTimes(5);
  });

  it("says so once when the database comes back", async () => {
    const { connectDB } = await freshModule();
    vi.spyOn(console, "error").mockImplementation(() => {});
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    connect.mockRejectedValueOnce(new Error("down")).mockResolvedValue({ ok: true });

    await connectDB().catch(() => {});
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
