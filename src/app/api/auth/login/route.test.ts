import { describe, it, expect, vi, beforeEach } from "vitest";

const verifyCredentials = vi.fn();
const createSession = vi.fn();
const revokeSession = vi.fn();
const revokeUserSessions = vi.fn();

vi.mock("@/lib/db", () => ({ connectDB: vi.fn() }));
vi.mock("@/models/session", () => ({ Session: {} }));
vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return { ...actual, verifyCredentials };
});
vi.mock("@/lib/session", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/session")>();
  return { ...actual, createSession, revokeSession, revokeUserSessions };
});

const { POST } = await import("./route");
const { clearAttempts, lockoutKey } = await import("@/lib/rate-limit");
const { SESSION_IDLE_TTL_MS, SESSION_ABSOLUTE_TTL_MS } = await import("@/lib/session");

const USER = {
  _id: "u1",
  username: "rpo",
  fullName: "Rafal",
  email: "rpo@example.com",
  emailNotifications: true,
  collapseEmptyColumns: false,
  role: "admin",
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
};

const CREDENTIALS = { username: "rpo", password: "correct-horse" };

function request(
  headers: Record<string, string> = { "sec-fetch-site": "same-origin" },
  body: unknown = CREDENTIALS
) {
  return new Request("https://app.example.com/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

function setCookies(response: Response): string[] {
  return response.headers.getSetCookie();
}

function sessionCookie(response: Response): string | undefined {
  return setCookies(response).find((cookie) => cookie.includes("=cps_"));
}

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.COOKIE_ALLOW_INSECURE;
  delete process.env.APP_ORIGIN;
  // Built with lockoutKey rather than hand-spelled: a literal here silently stops matching the
  // moment the key shape changes, and the leaked counter then fails a different test
  clearAttempts(lockoutKey("unknown", "rpo"));
  clearAttempts(lockoutKey("203.0.113.9", "rpo"));
  verifyCredentials.mockResolvedValue(USER);
  createSession.mockResolvedValue({
    token: "cps_deadbeef",
    sessionId: "s1",
    expiresAt: new Date(Date.now() + SESSION_IDLE_TTL_MS),
    absoluteExpiresAt: new Date(Date.now() + SESSION_ABSOLUTE_TTL_MS),
  });
});

describe("POST /api/auth/login — provenance", () => {
  it("refuses a cross-site post before any credential check", async () => {
    const response = await POST(request({ "sec-fetch-site": "cross-site" }));

    expect(response.status).toBe(403);
    expect(verifyCredentials).not.toHaveBeenCalled();
    expect(createSession).not.toHaveBeenCalled();
    expect(setCookies(response)).toEqual([]);
  });

  it("refuses a post carrying neither Sec-Fetch-Site nor Origin", async () => {
    const response = await POST(request({}));

    expect(response.status).toBe(403);
    expect(verifyCredentials).not.toHaveBeenCalled();
    expect(setCookies(response)).toEqual([]);
  });

  it("refuses an Origin that is not in APP_ORIGIN", async () => {
    process.env.APP_ORIGIN = "https://app.example.com";

    const response = await POST(request({ origin: "https://evil.example.com" }));

    expect(response.status).toBe(403);
    expect(verifyCredentials).not.toHaveBeenCalled();
  });

  it("accepts an Origin listed in APP_ORIGIN when Sec-Fetch-Site is absent", async () => {
    process.env.APP_ORIGIN = "https://app.example.com,http://192.168.1.10:3000";

    const response = await POST(request({ origin: "http://192.168.1.10:3000" }));

    expect(response.status).toBe(200);
  });

  it("ignores x-forwarded-host when deciding provenance", async () => {
    process.env.APP_ORIGIN = "https://app.example.com";

    const response = await POST(
      request({ origin: "https://evil.example.com", "x-forwarded-host": "app.example.com" })
    );

    expect(response.status).toBe(403);
  });
});

describe("POST /api/auth/login — credentials", () => {
  it("returns the user in the shape /api/auth/me returns", async () => {
    const response = await POST(request());

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      _id: "u1",
      username: "rpo",
      fullName: "Rafal",
      email: "rpo@example.com",
      emailNotifications: true,
      collapseEmptyColumns: false,
      role: "admin",
      createdAt: USER.createdAt.toISOString(),
    });
  });

  it("refuses wrong credentials without setting a cookie", async () => {
    verifyCredentials.mockResolvedValue(null);

    const response = await POST(request());

    expect(response.status).toBe(401);
    expect(createSession).not.toHaveBeenCalled();
    expect(setCookies(response)).toEqual([]);
  });

  it("locks out after the existing threshold, without reaching the password check", async () => {
    verifyCredentials.mockResolvedValue(null);
    for (let attempt = 0; attempt < 10; attempt++) {
      expect((await POST(request())).status).toBe(401);
    }

    verifyCredentials.mockClear();
    const response = await POST(request());

    expect(response.status).toBe(429);
    expect(verifyCredentials).not.toHaveBeenCalled();
  });

  it("keys the lockout on the client ip as well as the username", async () => {
    verifyCredentials.mockResolvedValue(null);
    for (let attempt = 0; attempt < 10; attempt++) {
      await POST(request());
    }

    verifyCredentials.mockResolvedValue(USER);
    const response = await POST(
      request({ "sec-fetch-site": "same-origin", "x-forwarded-for": "203.0.113.9" })
    );

    expect(response.status).toBe(200);
  });

  it("rejects a malformed body before touching the password check", async () => {
    expect((await POST(request({ "sec-fetch-site": "same-origin" }, "{"))).status).toBe(400);
    expect((await POST(request({ "sec-fetch-site": "same-origin" }, { username: "rpo" }))).status).toBe(400);
    expect(verifyCredentials).not.toHaveBeenCalled();
  });
});

describe("POST /api/auth/login — cookie", () => {
  it("sets a __Host- prefixed, HttpOnly, Secure, SameSite=Lax cookie on / by default", async () => {
    const cookie = sessionCookie(await POST(request()));

    expect(cookie).toContain("__Host-bp_session=cps_deadbeef");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).toContain("Path=/");
  });

  it("drops Secure and the prefix when the operator opts into insecure cookies", async () => {
    process.env.COOKIE_ALLOW_INSECURE = "1";
    process.env.APP_ORIGIN = "http://localhost:3000";

    const cookie = sessionCookie(await POST(request()));

    expect(cookie).toContain("bp_session=cps_deadbeef");
    expect(cookie).not.toContain("__Host-");
    expect(cookie).not.toContain("Secure");
  });

  it("leaves secure mode on for flag values that are not exactly \"1\"", async () => {
    for (const value of ["false", "0", "true", "yes"]) {
      process.env.COOKIE_ALLOW_INSECURE = value;
      expect(sessionCookie(await POST(request()))).toContain("__Host-bp_session=");
    }
  });

  it("expires the legacy cookie name alongside the one it issues", async () => {
    const cookies = setCookies(await POST(request()));

    const legacy = cookies.find((cookie) => cookie.startsWith("bp_session="));
    expect(legacy).toContain("Max-Age=0");
    expect(cookies).toHaveLength(2);
  });

  it("records the user agent and client ip on the session it creates", async () => {
    await POST(
      request({
        "sec-fetch-site": "same-origin",
        "user-agent": "Firefox/1",
        "x-forwarded-for": "203.0.113.9",
      })
    );

    expect(createSession).toHaveBeenCalledWith({
      userId: "u1",
      userAgent: "Firefox/1",
      ip: "203.0.113.9",
    });
  });

  it("issues a fresh row and deletes nothing", async () => {
    await POST(request({ "sec-fetch-site": "same-origin", "user-agent": "Chrome/1" }));
    await POST(request({ "sec-fetch-site": "same-origin", "user-agent": "Chrome/1" }));

    expect(createSession).toHaveBeenCalledTimes(2);
    expect(revokeSession).not.toHaveBeenCalled();
    expect(revokeUserSessions).not.toHaveBeenCalled();
  });
});
