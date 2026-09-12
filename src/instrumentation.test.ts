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
 * say so — but every path that reached the module ran inside `register`'s try, whose catch calls it
 * a MongoDB connection failure. The container stayed up, the schedulers below the throw never
 * started, and every route touching a secret answered 500.
 */
describe("register", () => {
  const ORIGINAL = { ...process.env };

  afterEach(() => {
    process.env = { ...ORIGINAL };
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it("fails to start on a malformed ENCRYPTION_KEY, rather than serving without its schedulers", async () => {
    process.env.NEXT_RUNTIME = "nodejs";
    process.env.ENCRYPTION_KEY = "not-32-bytes";
    vi.spyOn(console, "log").mockImplementation(() => {});
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const { register } = await import("./instrumentation");

    await expect(register()).rejects.toThrow(/ENCRYPTION_KEY is set but is not 32 bytes/);

    // Not swallowed and mislabelled: the operator must not be sent to look at the database
    expect(logged).not.toHaveBeenCalledWith(
      expect.stringContaining("Startup MongoDB connection failed"),
      expect.anything()
    );
  });
});
