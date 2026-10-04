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
const admins = vi.fn((): unknown[] => []);
const userFind = vi.fn(() => ({ select: () => ({ lean: () => Promise.resolve(admins()) }) }));
const setupCode = vi.fn();
const markPmAsMachine = vi.fn(() => Promise.resolve());
const repairMachineNames = vi.fn(() => Promise.resolve(0));
const startPmScheduler = vi.fn();
const startGithubSyncScheduler = vi.fn(() => ({ started: true as const, tickMs: 300_000 }));
const startDigestScheduler = vi.fn(() => ({ started: true as const, tickMs: 300_000 }));

const backfillTenants = vi.fn((): Promise<unknown> => Promise.resolve({ total: 0, byCollection: {} }));
vi.mock("@/lib/tenant-migration", () => ({ backfillTenants }));
vi.mock("@/lib/tenant-jobs", async () => {
  const { scoped } = await import("@/lib/db-scope");
  const { DEFAULT_TENANT_ID } = await import("@/lib/tenant-field");
  return {
    forEachServedTenant: async (_job: string, work: (db: unknown, tenant: unknown) => Promise<void>) =>
      work(scoped(DEFAULT_TENANT_ID), { _id: DEFAULT_TENANT_ID }),
  };
});
vi.mock("@/models/project", () => ({ Project: { updateMany } }));
vi.mock("@/lib/agent-seed", () => ({ seedAgents }));
vi.mock("@/models/user", () => ({ User: { countDocuments, find: userFind } }));
vi.mock("@/models/identity", () => ({ Identity: { exists: () => Promise.resolve(null) } }));
vi.mock("@/lib/setup-code", () => ({ setupCode }));
vi.mock("@/lib/pm/pm-user", () => ({ markPmAsMachine }));
vi.mock("@/lib/worker-user", () => ({ repairMachineNames }));
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

  // BP-802: a browser closing a page mid-autosave is not a crash of this server
  it("says a client hung up, and not that an error went unhandled", () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const warned = vi.spyOn(console, "warn").mockImplementation(() => {});

    onRequestError(
      Object.assign(new Error("aborted"), { code: "ECONNRESET" }),
      { path: "/api/projects/TP/tasks/t1?x=1", method: "PUT", headers: {} },
      { routerKind: "App Router", routePath: "/api/projects/[projectId]/tasks/[taskId]", routeType: "route", revalidateReason: undefined }
    );

    expect(logged).not.toHaveBeenCalled();
    expect(warned).toHaveBeenCalledWith("Client closed the connection mid-request — PUT /api/projects/TP/tasks/t1");
  });

  it("still reports an ordinary error named aborted as unhandled", () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});

    onRequestError(
      new Error("aborted"),
      { path: "/api/x", method: "GET", headers: {} },
      { routerKind: "App Router", routePath: "/api/x", routeType: "route", revalidateReason: undefined }
    );

    expect(logged.mock.calls[0][0]).toContain("Unhandled error");
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

  // BP-773. The check ran only when the login route first loaded the module, so a misconfigured
  // compose deployment was up and healthy and answered every sign-in with a 500.
  it("exits on an insecure cookie over an https origin rather than failing each sign-in", async () => {
    process.env.NEXT_RUNTIME = "nodejs";
    delete process.env.ENCRYPTION_KEY;
    process.env.COOKIE_ALLOW_INSECURE = "1";
    process.env.APP_ORIGIN = "https://board.example.com";
    vi.spyOn(console, "log").mockImplementation(() => {});
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`exit:${code}`);
    }) as never);
    const { register } = await import("./instrumentation");

    await expect(register()).rejects.toThrow("exit:1");
    expect(logged).toHaveBeenCalledWith(expect.stringContaining("COOKIE_ALLOW_INSECURE=1 requires"));
  });

  // BP-830. Passwords off with no provider is an instance nobody can sign in to
  it("exits when password sign-in is off and no provider is configured", async () => {
    process.env.NEXT_RUNTIME = "nodejs";
    delete process.env.ENCRYPTION_KEY;
    process.env.PASSWORD_SIGN_IN = "off";
    for (const key of ["OIDC_ISSUER", "GOOGLE_CLIENT_ID", "GITHUB_OAUTH_CLIENT_ID"]) delete process.env[key];
    vi.spyOn(console, "log").mockImplementation(() => {});
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`exit:${code}`);
    }) as never);
    const { register } = await import("./instrumentation");

    await expect(register()).rejects.toThrow("exit:1");
    expect(logged).toHaveBeenCalledWith(expect.stringContaining("PASSWORD_SIGN_IN=off needs a sign-in provider"));
  });

  it("exits on a TENANT_DOMAIN that is not a bare domain (BP-666)", async () => {
    process.env.NEXT_RUNTIME = "nodejs";
    delete process.env.ENCRYPTION_KEY;
    process.env.TENANT_DOMAIN = "https://board-planner.com";
    vi.spyOn(console, "log").mockImplementation(() => {});
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`exit:${code}`);
    }) as never);
    const { register } = await import("./instrumentation");

    await expect(register()).rejects.toThrow("exit:1");
    expect(logged).toHaveBeenCalledWith(expect.stringContaining("TENANT_DOMAIN must be a bare domain"));
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

  // BP-650. Unlike ENCRYPTION_KEY, a bad licence is the Free plan, never a crash-loop
  it("starts with a malformed LICENCE_KEY and says so once in the log", async () => {
    process.env.NEXT_RUNTIME = "nodejs";
    delete process.env.ENCRYPTION_KEY;
    process.env.LICENCE_KEY = "not-a-licence";
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    const warned = vi.spyOn(console, "warn").mockImplementation(() => {});
    const exited = vi.spyOn(process, "exit").mockImplementation((() => {}) as never);
    const { register } = await import("./instrumentation");

    await register();

    expect(exited).not.toHaveBeenCalled();
    const licenceLines = warned.mock.calls.filter(([line]) => String(line).startsWith("LICENCE_KEY"));
    expect(licenceLines).toEqual([[expect.stringContaining("is not a licence key")]]);
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
    expect(repairMachineNames).toHaveBeenCalledTimes(1);
  });

  // BP-840. Said, not refused: exiting would make a restart an outage for every member, over a
  // state a runtime demotion or deactivation can reach
  it("warns once connected when passwords off would leave no administrator a way in, and keeps serving", async () => {
    process.env.NEXT_RUNTIME = "nodejs";
    delete process.env.ENCRYPTION_KEY;
    Object.assign(process.env, {
      PASSWORD_SIGN_IN: "off",
      OIDC_ISSUER: "https://id.example.com",
      OIDC_CLIENT_ID: "c",
      OIDC_CLIENT_SECRET: "s",
    });
    admins.mockReturnValue([{ _id: "a1", emailVerifiedAt: null }]);
    connectDB.mockImplementationOnce(() => Promise.resolve());
    vi.spyOn(console, "log").mockImplementation(() => {});
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const exit = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`exit:${code}`);
    }) as never);
    const { register } = await import("./instrumentation");

    await register();
    expect(exit).not.toHaveBeenCalled();
    expect(logged).toHaveBeenCalledWith(expect.stringContaining("WARNING: PASSWORD_SIGN_IN=off, but no active administrator"));
    await vi.waitFor(() => expect(startPmScheduler).toHaveBeenCalledTimes(1));
    admins.mockReturnValue([]);
  });

  // BP-425. Every boot, like the catalog seed, and just as unable to keep the schedulers down
  it("repairs machine names at boot, and still starts the schedulers when that fails", async () => {
    process.env.NEXT_RUNTIME = "nodejs";
    delete process.env.ENCRYPTION_KEY;
    vi.spyOn(console, "log").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    connectDB.mockImplementation(() => Promise.resolve());
    repairMachineNames.mockImplementationOnce(() => Promise.reject(new Error("users collection is gone")));
    const { register } = await import("./instrumentation");

    await register();

    expect(repairMachineNames).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledWith("Failed to repair machine names:", expect.any(Error));
    expect(startPmScheduler).toHaveBeenCalledTimes(1);
  });

  // BP-663: with queries scoped, a row with no organisation is invisible rather than wrong
  it("counts rows with no organisation at boot, warns when there are any, and writes nothing", async () => {
    process.env.NEXT_RUNTIME = "nodejs";
    delete process.env.ENCRYPTION_KEY;
    vi.spyOn(console, "log").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    connectDB.mockImplementation(() => Promise.resolve());
    backfillTenants.mockReset().mockResolvedValue({ total: 3, byCollection: { tasks: 3 } });
    const { register } = await import("./instrumentation");

    await register();

    expect(backfillTenants).toHaveBeenCalledWith(expect.anything(), { apply: false });
    expect(error).toHaveBeenCalledWith(expect.stringContaining("WARNING: 3 row(s) belong to no organisation"));
    expect(startPmScheduler).toHaveBeenCalledTimes(1);
  });

  it("says nothing when every row has an organisation, and still starts when counting fails", async () => {
    process.env.NEXT_RUNTIME = "nodejs";
    delete process.env.ENCRYPTION_KEY;
    vi.spyOn(console, "log").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    connectDB.mockImplementation(() => Promise.resolve());
    backfillTenants.mockReset().mockRejectedValueOnce(new Error("listCollections failed"));
    const { register } = await import("./instrumentation");

    await register();

    expect(error).toHaveBeenCalledWith("Failed to count rows with no organisation:", expect.any(Error));
    expect(error).not.toHaveBeenCalledWith(expect.stringContaining("belong to no organisation"));
    expect(startPmScheduler).toHaveBeenCalledTimes(1);
  });

  // The test above proves the retry happens within 30s; this pins it to that value specifically,
  // so a regression that made it near-instant would not slip through unnoticed (review).
  it("waits the full 30 s before retrying, not less", async () => {
    vi.useFakeTimers();
    process.env.NEXT_RUNTIME = "nodejs";
    delete process.env.ENCRYPTION_KEY;
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { DatabaseUnavailableError } = await import("@/lib/db");
    connectDB.mockImplementationOnce(() => Promise.reject(new DatabaseUnavailableError(new Error("down"))));
    const { register } = await import("./instrumentation");

    await register();
    expect(connectDB).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(29_999);
    expect(connectDB).toHaveBeenCalledTimes(1); // not yet

    await vi.advanceTimersByTimeAsync(1);
    expect(connectDB).toHaveBeenCalledTimes(2);
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
