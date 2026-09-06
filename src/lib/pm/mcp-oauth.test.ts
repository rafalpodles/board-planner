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

describe("getPmOauthRedirectUri", () => {
  it("builds the callback from the configured origin", () => {
    process.env.PUBLIC_ORIGIN = "https://board.example.com";

    expect(getPmOauthRedirectUri()).toBe("https://board.example.com/api/pm/oauth/callback");
  });

  it("takes no argument, so no request can reach it", () => {
    process.env.PUBLIC_ORIGIN = "https://board.example.com";

    expect(getPmOauthRedirectUri.length).toBe(0);
    expect(getPmOauthRedirectUri()).toBe("https://board.example.com/api/pm/oauth/callback");
  });

  it("refuses rather than registering a guessed address", () => {
    expect(() => getPmOauthRedirectUri()).toThrow(/PUBLIC_ORIGIN/);
  });

  it("refuses an origin that new URL() accepts but cannot address", () => {
    process.env.PUBLIC_ORIGIN = "board.example.com:8443";

    expect(() => getPmOauthRedirectUri()).toThrow(/PUBLIC_ORIGIN/);
  });
});
