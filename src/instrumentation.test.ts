import { describe, it, expect, vi, afterEach } from "vitest";
import { onRequestError } from "./instrumentation";

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
