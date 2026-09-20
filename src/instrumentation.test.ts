import { describe, it, expect, vi, afterEach } from "vitest";
import { onRequestError } from "./instrumentation";

/**
 * `register()` does not stop at the encryption block: below it sit two `updateMany` backfills, the
 * agent-catalogue seed and two `setInterval`s. The keyless test runs all of that, and nothing in
 * the vitest config pins `MONGODB_URI` — so on a machine where one is exported, `npm test` wrote
 * to a real database. Measured: it set `categories` on a live project and created `agents`.
 *
 * The real DatabaseUnavailableError, not a fake one: db-errors.ts is kept free of any mongoose
 * import for exactly this reason (its own file header says so), so importing it here is safe and
 * an `instanceof` check against it behaves exactly as it does against the unmocked module.
 */
const connectDB = vi.fn<() => Promise<unknown>>(() =>
  Promise.reject(new Error("unit test: no database"))
);
vi.mock("@/lib/db", async () => {
  const { DatabaseUnavailableError } = await import("@/lib/db-errors");
  return { connectDB, DatabaseUnavailableError };
});

// Everything register() reaches for once connectDB() resolves — mocked at module scope, like
// connectDB above, because a vi.mock factory is hoisted above the whole file and cannot close over
// a variable that lives inside a describe() block, only one declared here.
const updateMany = vi.fn(() => Promise.resolve({ modifiedCount: 0 }));
const seedAgents = vi.fn(() => Promise.resolve());
const countDocuments = vi.fn(() => Promise.resolve(1));
const setupCode = vi.fn();
const markPmAsMachine = vi.fn(() => Promise.resolve());
const startPmScheduler = vi.fn();
const startGithubSyncScheduler = vi.fn(() => ({ started: true as const, tickMs: 300_000 }));
const startDigestScheduler = vi.fn(() => ({ started: true as const, tickMs: 300_000 }));

vi.mock("@/models/project", () => ({ Project: { updateMany } }));
vi.mock("@/lib/agent-seed", () => ({ seedAgents }));
vi.mock("@/models/user", () => ({ User: { countDocuments } }));
vi.mock("@/lib/setup-code", () => ({ setupCode }));
vi.mock("@/lib/pm/pm-user", () => ({ markPmAsMachine }));
vi.mock("@/lib/pm/scheduler", () => ({ startPmScheduler }));
vi.mock("@/lib/github-sync", () => ({ startGithubSyncScheduler }));
vi.mock("@/lib/digest", () => ({
  startDigestScheduler,
  digestHour: () => 7,
  digestTimezone: () => "Europe/Warsaw",
}));

/**
 * Our half of Next's contract. The other half — that Next calls this at all — is not testable from
 * here and was verified by hand against both `next dev` and `next start`, which is the one Railway
 * runs: with the BP-444 fix reverted, `next start` logged the stack with no path (exactly what the
 * incident had) plus this line naming the request.
 */
describe("onRequestError", () => {
  afterEach(() => vi.restoreAllMocks());

  it("writes one line naming the request the error escaped from", () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});

    onRequestError(
      new TypeError("Content-Type was not one of …"),
      { path: "/oauth/token", method: "POST", headers: { "content-type": "application/json" } },
      {
        routerKind: "App Router",
        routePath: "/oauth/token",
        routeType: "route",
        revalidateReason: undefined,
      }
    );

    expect(logged).toHaveBeenCalledTimes(1);
    expect(logged.mock.calls[0][0]).toContain("POST /oauth/token");
  });
});

/**
 * BP-372. `assertEncryptionConfig` has thrown on a malformed key since BP-282, and four documents
 * say the app will not start. Two things were in the way. The throw was reached only through the
 * PM scheduler, inside `register`'s try, whose catch calls it a MongoDB connection failure — and
 * throwing at all is not enough under `next start`, where `NextServer.prepare()` awaits the real
 * prepare only in dev: the rejection is memoised and re-thrown per request, leaving a process that
 * is up, bound and answering 500 for ever. Measured against a production build before this test
 * was written. So the contract here is the exit, not the throw.
 */
describe("register", () => {
  const ORIGINAL = { ...process.env };

  afterEach(() => {
    process.env = { ...ORIGINAL };
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it("exits on a malformed ENCRYPTION_KEY rather than serving 500s for ever", async () => {
    process.env.NEXT_RUNTIME = "nodejs";
    process.env.ENCRYPTION_KEY = "not-32-bytes";
    vi.spyOn(console, "log").mockImplementation(() => {});
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    // Throws instead of exiting, so the rest of register() cannot run and the test can observe it
    const exited = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`exit:${code}`);
    }) as never);
    const { register } = await import("./instrumentation");

    await expect(register()).rejects.toThrow("exit:1");

    expect(exited).toHaveBeenCalledWith(1);
    // Named on the way out: an operator reading a crash-loop needs the variable, not a stack
    expect(logged).toHaveBeenCalledWith(
      expect.stringContaining("ENCRYPTION_KEY is set but is not 32 bytes")
    );
    // Not swallowed and mislabelled: the operator must not be sent to look at the database
    expect(logged).not.toHaveBeenCalledWith(
      expect.stringContaining("Startup MongoDB connection failed"),
      expect.anything()
    );
  });

  it("starts normally when no key is configured at all", async () => {
    process.env.NEXT_RUNTIME = "nodejs";
    delete process.env.ENCRYPTION_KEY;
    delete process.env.ENCRYPTION_KEYS_OLD;
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    const exited = vi.spyOn(process, "exit").mockImplementation((() => {}) as never);
    const { register } = await import("./instrumentation");

    await register();

    // A self-hosted instance that stores no secrets is not what this refuses
    expect(exited).not.toHaveBeenCalled();
  });
});

/**
 * BP-366. Before this, a boot-time connection failure gave up for the process's whole lifetime:
 * seeding, the agent-catalog backfill and all three schedulers never ran again until a redeploy,
 * even once the database came back — because nothing retried the sequence that runs after
 * `connectDB()`, only route handlers got to try again (BP-362).
 */
describe("register — a database that is down at boot", () => {
  const ORIGINAL = { ...process.env };

  afterEach(() => {
    process.env = { ...ORIGINAL };
    vi.restoreAllMocks();
    vi.resetModules();
    vi.useRealTimers();
  });

  it("retries a DatabaseUnavailableError, then runs seeding and starts the schedulers once it connects", async () => {
    vi.useFakeTimers();
    process.env.NEXT_RUNTIME = "nodejs";
    delete process.env.ENCRYPTION_KEY;
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { DatabaseUnavailableError } = await import("@/lib/db");
    connectDB
      .mockImplementationOnce(() => Promise.reject(new DatabaseUnavailableError(new Error("down"))))
      .mockImplementationOnce(() => Promise.resolve());
    const { register } = await import("./instrumentation");

    await register();
    expect(connectDB).toHaveBeenCalledTimes(1);
    expect(startPmScheduler).not.toHaveBeenCalled();

    // Fires the 30 s retry, then hands off to real timers: the retried call chains roughly a dozen
    // real dynamic imports and awaited mocks, more microtask ticks than a fake-timer flush drains
    // in one pass, and nothing further in that chain depends on fake time.
    await vi.advanceTimersByTimeAsync(30_000);
    vi.useRealTimers();
    await vi.waitFor(() => expect(startPmScheduler).toHaveBeenCalledTimes(1));

    expect(connectDB).toHaveBeenCalledTimes(2);
    expect(markPmAsMachine).toHaveBeenCalledTimes(1);
    expect(seedAgents).toHaveBeenCalledTimes(1);
  });

  // A plain misconfiguration (a malformed MONGODB_URI, say) will not come right by waiting —
  // retrying it forever would be silent log spam standing in for a fix only a person can make.
  it("does not retry a connection failure that is not a database outage", async () => {
    vi.useFakeTimers();
    process.env.NEXT_RUNTIME = "nodejs";
    delete process.env.ENCRYPTION_KEY;
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    connectDB.mockImplementation(() => Promise.reject(new Error("MONGODB_URI is not defined")));
    const { register } = await import("./instrumentation");

    await register();
    await vi.advanceTimersByTimeAsync(60_000);

    expect(connectDB).toHaveBeenCalledTimes(1);
    expect(startPmScheduler).not.toHaveBeenCalled();
  });
});
