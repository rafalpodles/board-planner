import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@/lib/db", () => ({ connectDB: vi.fn() }));
vi.mock("@/models/session", () => ({ Session: {} }));
vi.mock("@/lib/safe-fetch", () => ({ safeFetch: vi.fn() }));
vi.mock("@/lib/url-validation", () => ({ isAllowedMcpServerUrl: () => true }));

const { getPmOauthRedirectUri } = await import("./mcp-oauth");

const ORIGINAL = { ...process.env };

beforeEach(() => {
  delete process.env.APP_ORIGIN;
  delete process.env.PUBLIC_ORIGIN;
  delete process.env.NEXT_PUBLIC_APP_URL;
});

afterEach(() => {
  process.env = { ...ORIGINAL };
});

// This value is registered with a third-party authorization server and is where an unauthenticated
// callback lands, so it must not come from the request that happens to start the flow. The only
// test that touched it mocked this function away, so restoring the old request-derived body left
// the suite green (BP-316 review).
describe("getPmOauthRedirectUri", () => {
  it("builds the callback from the configured origin", () => {
    process.env.PUBLIC_ORIGIN = "https://board.example.com";

    expect(getPmOauthRedirectUri()).toBe("https://board.example.com/api/pm/oauth/callback");
  });

  it("takes no argument, so no request can reach it", () => {
    process.env.PUBLIC_ORIGIN = "https://board.example.com";

    // A request-derived implementation needs the request; this pins that it is not threaded in
    expect(getPmOauthRedirectUri.length).toBe(0);
    expect(getPmOauthRedirectUri()).toBe("https://board.example.com/api/pm/oauth/callback");
  });

  it("refuses rather than registering a guessed address", () => {
    expect(() => getPmOauthRedirectUri()).toThrow(/PUBLIC_ORIGIN/);
  });

  // "board.example.com:8443" parses as an opaque URL whose origin is the string "null", which is
  // truthy — the redirect_uri would have been registered as "null/api/pm/oauth/callback"
  it("refuses an origin that new URL() accepts but cannot address", () => {
    process.env.PUBLIC_ORIGIN = "board.example.com:8443";

    expect(() => getPmOauthRedirectUri()).toThrow(/PUBLIC_ORIGIN/);
  });
});
