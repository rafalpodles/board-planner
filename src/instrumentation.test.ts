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
