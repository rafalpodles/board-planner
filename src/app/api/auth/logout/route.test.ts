import { describe, it, expect, vi, beforeEach } from "vitest";

const revokeSession = vi.fn();

vi.mock("@/lib/db", () => ({ connectDB: vi.fn() }));
vi.mock("@/models/session", () => ({ Session: {} }));
vi.mock("@/lib/session", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/session")>();
  return { ...actual, revokeSession };
});

const { POST } = await import("./route");

function request(headers: Record<string, string> = { "sec-fetch-site": "same-origin" }) {
  return new Request("https://app.example.com/api/auth/logout", { method: "POST", headers });
}

function withSession(extra: Record<string, string> = {}) {
  return request({
    "sec-fetch-site": "same-origin",
    cookie: "__Host-bp_session=cps_deadbeef",
    ...extra,
  });
}

function setCookies(response: Response): string[] {
  return response.headers.getSetCookie();
}

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.COOKIE_ALLOW_INSECURE;
  delete process.env.APP_ORIGIN;
  revokeSession.mockResolvedValue(true);
});

describe("POST /api/auth/logout", () => {
  it("refuses a cross-site post before revoking anything", async () => {
    const response = await POST(withSession({ "sec-fetch-site": "cross-site" }));

    expect(response.status).toBe(403);
    expect(revokeSession).not.toHaveBeenCalled();
    expect(setCookies(response)).toEqual([]);
  });

  it("refuses a post carrying neither Sec-Fetch-Site nor Origin", async () => {
    const response = await POST(request({ cookie: "__Host-bp_session=cps_deadbeef" }));

    expect(response.status).toBe(403);
    expect(revokeSession).not.toHaveBeenCalled();
  });

  it("deletes the row and clears the cookie", async () => {
    const response = await POST(withSession());

    expect(response.status).toBe(200);
    expect(revokeSession).toHaveBeenCalledWith("cps_deadbeef");
    expect(setCookies(response)).toEqual([
      expect.stringContaining("__Host-bp_session=;"),
      expect.stringContaining("bp_session=;"),
    ]);
    for (const cookie of setCookies(response)) {
      expect(cookie).toContain("Max-Age=0");
      expect(cookie).toContain("Path=/");
      expect(cookie).toContain("HttpOnly");
      expect(cookie).toContain("SameSite=Lax");
    }
  });

  it("clears the cookie even when no row matched", async () => {
    revokeSession.mockResolvedValue(false);

    const response = await POST(withSession());

    expect(response.status).toBe(200);
    expect(setCookies(response)).toHaveLength(2);
  });

  it("answers a request with no session at all instead of a 401 that would strand the cookie", async () => {
    const response = await POST(request());

    expect(response.status).toBe(200);
    expect(revokeSession).not.toHaveBeenCalled();
    expect(setCookies(response)).toHaveLength(2);
  });

  it("clears both cookie names in insecure mode too", async () => {
    process.env.COOKIE_ALLOW_INSECURE = "1";
    process.env.APP_ORIGIN = "http://localhost:3000";

    const response = await POST(
      request({ "sec-fetch-site": "same-origin", cookie: "bp_session=cps_deadbeef" })
    );

    expect(revokeSession).toHaveBeenCalledWith("cps_deadbeef");
    expect(setCookies(response)).toHaveLength(2);
  });
});
