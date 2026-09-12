import { describe, it, expect, vi, afterEach } from "vitest";
import { onRequestError } from "./instrumentation";

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
