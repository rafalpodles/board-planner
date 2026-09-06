import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const connectDB = vi.fn();
const verifyCredentials = vi.fn();
const createSession = vi.fn();
const revokeSession = vi.fn();
const revokeUserSessions = vi.fn();

// The real module, so DatabaseUnavailableError is the class the route checks against — a bare
// stub makes `instanceof` throw inside the catch instead of answering
vi.mock("@/lib/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/db")>()),
  connectDB,
}));
vi.mock("@/models/rateLimit", async () => {
  const { inMemoryRateLimitModel } = await import("@/lib/rate-limit-test-store");
  return { RateLimit: inMemoryRateLimitModel() };
});

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
const { DatabaseUnavailableError } = await import("@/lib/db");
const { resetRateLimits, ANONYMOUS_ACCOUNT_ATTEMPTS, ANONYMOUS_GLOBAL_ATTEMPTS } = await import(
  "@/lib/rate-limit"
);
const { SESSION_IDLE_TTL_MS, SESSION_ABSOLUTE_TTL_MS } = await import("@/lib/session");

const USER = {
  _id: "u1",
  username: "owner",
  fullName: "Owner",
  email: "owner@example.com",
  emailNotifications: true,
  collapseEmptyColumns: false,
  role: "admin",
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
};

const CREDENTIALS = { username: "owner", password: "correct-horse" };

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

beforeEach(async () => {
  vi.clearAllMocks();
  connectDB.mockResolvedValue(undefined);
  await resetRateLimits();
  // The per-address cases below send X-Forwarded-For, which counts only where the operator says a
  // proxy writes it. The unconfigured case has its own tests further down (BP-318).
  process.env.TRUSTED_PROXY_HOPS = "1";
  delete process.env.COOKIE_ALLOW_INSECURE;
  delete process.env.APP_ORIGIN;
  verifyCredentials.mockResolvedValue(USER);
  createSession.mockResolvedValue({
    token: "cps_deadbeef",
    sessionId: "s1",
    expiresAt: new Date(Date.now() + SESSION_IDLE_TTL_MS),
    absoluteExpiresAt: new Date(Date.now() + SESSION_ABSOLUTE_TTL_MS),
  });
});

afterEach(() => {
  delete process.env.TRUSTED_PROXY_HOPS;
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
      username: "owner",
      fullName: "Owner",
      email: "owner@example.com",
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

  it("bounds guessing even with no client identity, and a success does not reopen the budget", async () => {
    verifyCredentials.mockResolvedValue(null);
    for (let attempt = 0; attempt < ANONYMOUS_ACCOUNT_ATTEMPTS; attempt++) {
      await POST(request());
    }

    verifyCredentials.mockClear();
    verifyCredentials.mockResolvedValue(USER);
    const refused = await POST(request());

    expect(refused.status).toBe(429);
    // Refused before the credential is read, which is what bounds the bcrypt work. The cost is that
    // this refusal can be aimed where the key is shared — BP-353 answers that with a way out
    // (a password change clears the counter), not by moving this check.
    expect(verifyCredentials).not.toHaveBeenCalled();
  });

  it("still refuses everyone once the anonymous work budget is spent", async () => {
    verifyCredentials.mockResolvedValue(null);
    for (let attempt = 0; attempt < ANONYMOUS_GLOBAL_ATTEMPTS; attempt++) {
      await POST(
        request({ "sec-fetch-site": "same-origin" }, {
          username: `victim-${attempt}`,
          password: "guess",
        })
      );
    }

    verifyCredentials.mockClear();
    verifyCredentials.mockResolvedValue(USER);
    const response = await POST(request());

    expect(response.status).toBe(429);
    expect(verifyCredentials).not.toHaveBeenCalled();
  });

  it("a valid login never clears the source budget, so one account cannot fund guessing others", async () => {
    const from = (username: string) =>
      request({ "sec-fetch-site": "same-origin", "x-forwarded-for": "203.0.113.9" }, {
        username,
        password: "guess",
      });

    verifyCredentials.mockResolvedValue(null);
    for (let attempt = 0; attempt < 40; attempt++) await POST(from(`victim-${attempt}`));

    // A real login of the attacker's own account, from the same address
    verifyCredentials.mockResolvedValue(USER);
    expect((await POST(from("mine"))).status).toBe(200);

    // If success had cleared the source counter the budget would be back to zero and this would
    // keep answering 401 forever
    verifyCredentials.mockResolvedValue(null);
    let refusedAt = -1;
    for (let attempt = 0; attempt < 30; attempt++) {
      if ((await POST(from(`later-${attempt}`))).status === 429) {
        refusedAt = attempt;
        break;
      }
    }

    expect(refusedAt).toBeGreaterThanOrEqual(0);
  });

  it("refuses an address spraying many usernames, which no per-account counter would catch", async () => {
    const from = (username: string) =>
      request({ "sec-fetch-site": "same-origin", "x-forwarded-for": "203.0.113.9" }, {
        username,
        password: "guess",
      });

    verifyCredentials.mockResolvedValue(null);
    let refusedAt = -1;
    for (let attempt = 0; attempt < 60; attempt++) {
      // One try per account, so every account counter stays at 1 and only the source accumulates
      if ((await POST(from(`victim-${attempt}`))).status === 429) {
        refusedAt = attempt;
        break;
      }
    }

    expect(refusedAt).toBeGreaterThan(10);

    verifyCredentials.mockClear();
    verifyCredentials.mockResolvedValue(USER);
    expect((await POST(from("someone-else"))).status).toBe(429);
    expect(verifyCredentials).not.toHaveBeenCalled();
  });

  // The whole point of BP-318, and the case the rest of this file cannot show because it sets
  // TRUSTED_PROXY_HOPS: with no proxy configured the header is not an identity, so rotating it
  // buys nothing. Before the fix each value was a fresh bucket and this loop never saw a 429.
  it("does not sell a fresh bucket for a forged address when no proxy is configured", async () => {
    delete process.env.TRUSTED_PROXY_HOPS;
    verifyCredentials.mockResolvedValue(null);

    let refusedAt = -1;
    for (let attempt = 0; attempt < 80; attempt++) {
      const forged = `203.0.113.${attempt % 256}`;
      const res = await POST(
        request({ "sec-fetch-site": "same-origin", "x-forwarded-for": forged }, {
          username: "victim",
          password: `guess-${attempt}`,
        })
      );
      if (res.status === 429) {
        refusedAt = attempt;
        break;
      }
    }

    expect(refusedAt).toBeGreaterThan(0);
    expect(refusedAt).toBeLessThanOrEqual(ANONYMOUS_ACCOUNT_ATTEMPTS);
  });

  it("does not sell one either by varying the spelling of the username", async () => {
    delete process.env.TRUSTED_PROXY_HOPS;
    verifyCredentials.mockResolvedValue(null);
    const spellings = ["victim", " victim", "victim ", "VICTIM", "\tvictim", "  Victim  "];

    let refusedAt = -1;
    for (let attempt = 0; attempt < 80; attempt++) {
      const res = await POST(
        request({ "sec-fetch-site": "same-origin" }, {
          username: spellings[attempt % spellings.length],
          password: `guess-${attempt}`,
        })
      );
      if (res.status === 429) {
        refusedAt = attempt;
        break;
      }
    }

    expect(refusedAt).toBeGreaterThan(0);
    expect(refusedAt).toBeLessThanOrEqual(ANONYMOUS_ACCOUNT_ATTEMPTS);
  });

  it("refusing one address leaves another address alone", async () => {
    verifyCredentials.mockResolvedValue(null);
    for (let attempt = 0; attempt < 55; attempt++) {
      await POST(request({ "sec-fetch-site": "same-origin", "x-forwarded-for": "203.0.113.9" }));
    }

    verifyCredentials.mockResolvedValue(USER);
    const elsewhere = await POST(
      request({ "sec-fetch-site": "same-origin", "x-forwarded-for": "198.51.100.4" })
    );

    expect(elsewhere.status).toBe(200);
  });


  it("rejects a malformed body before touching the password check", async () => {
    expect((await POST(request({ "sec-fetch-site": "same-origin" }, "{"))).status).toBe(400);
    expect((await POST(request({ "sec-fetch-site": "same-origin" }, { username: "owner" }))).status).toBe(400);
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

describe("POST /api/auth/login — the database is unreachable", () => {
  // Reaching for the throttle counters is the first thing the route does that needs the database,
  // so an outage lands before any credential is looked at
  function databaseIsDown() {
    connectDB.mockImplementation(async () => {
      throw new DatabaseUnavailableError(new Error("connect ECONNREFUSED 127.0.0.1:27017"));
    });
  }

  it("answers 503, not 401", async () => {
    databaseIsDown();

    const response = await POST(request());

    expect(response.status).toBe(503);
  });

  // This is the page somebody was sent to *by* the outage. Telling them their password is wrong is
  // how a database restart turned into a support request about lost accounts (BP-362).
  it("does not tell anyone their credentials were rejected", async () => {
    databaseIsDown();

    const body = await (await POST(request())).json();

    expect(body.error).not.toMatch(/invalid credentials/i);
    expect(body.error).toMatch(/database is unreachable/i);
  });

  it("issues no session cookie", async () => {
    databaseIsDown();

    const response = await POST(request());

    expect(setCookies(response)).toEqual([]);
    expect(createSession).not.toHaveBeenCalled();
  });

  it("keeps refusing a wrong password with 401 while the database is up", async () => {
    verifyCredentials.mockResolvedValue(null);

    const response = await POST(request());
    const body = await response.json();

    expect(response.status).toBe(401);
    expect(body.error).toMatch(/invalid credentials/i);
  });

  it("still rejects a malformed body before it needs the database at all", async () => {
    databaseIsDown();

    const response = await POST(request({ "sec-fetch-site": "same-origin" }, "not json"));

    expect(response.status).toBe(400);
  });
});
