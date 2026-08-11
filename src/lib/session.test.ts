import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const findOne = vi.fn();
const updateOne = vi.fn();
const create = vi.fn();
const deleteOne = vi.fn();
const deleteMany = vi.fn();

vi.mock("./db", () => ({ connectDB: vi.fn() }));
vi.mock("@/models/session", () => ({
  Session: { findOne, updateOne, create, deleteOne, deleteMany },
}));

const {
  allowsInsecureCookie,
  appOrigins,
  assertSessionConfig,
  buildSessionCookie,
  checkProvenance,
  clearSessionCookies,
  createSession,
  legacySessionCookies,
  readSessionCookie,
  resolveSession,
  revokeSession,
  revokeUserSessions,
  sessionCookieName,
  SESSION_IDLE_TTL_MS,
  SESSION_ABSOLUTE_TTL_MS,
  SESSION_SLIDE_THROTTLE_MS,
} = await import("./session");

const DAY_MS = 24 * 60 * 60 * 1000;

function row(overrides: Record<string, unknown> = {}) {
  const now = Date.now();
  return {
    _id: "session-1",
    user: "user-1",
    expiresAt: new Date(now + SESSION_IDLE_TTL_MS),
    absoluteExpiresAt: new Date(now + 90 * DAY_MS),
    ...overrides,
  };
}

function found(value: unknown) {
  findOne.mockReturnValue({ lean: () => Promise.resolve(value) });
}

function mutating(headers: Record<string, string> = {}, method = "POST"): Request {
  return new Request("https://app.example.com/api/tasks", { method, headers });
}

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.COOKIE_ALLOW_INSECURE;
  delete process.env.APP_ORIGIN;
  found(null);
  updateOne.mockResolvedValue({});
  deleteOne.mockResolvedValue({ deletedCount: 1 });
  deleteMany.mockResolvedValue({ deletedCount: 3 });
  create.mockImplementation((doc) => Promise.resolve({ ...doc, _id: "new-session" }));
});

afterEach(() => {
  delete process.env.COOKIE_ALLOW_INSECURE;
  delete process.env.APP_ORIGIN;
});

describe("COOKIE_ALLOW_INSECURE parsing", () => {
  it("is off when unset", () => {
    expect(allowsInsecureCookie()).toBe(false);
  });

  // A Boolean(process.env.X) implementation passes every happy path and fails exactly here
  it.each(["false", "0", "", "no", "off", "true", "yes", " 1", "1 ", "01"])(
    "leaves secure mode on for %o",
    (value) => {
      process.env.COOKIE_ALLOW_INSECURE = value;
      expect(allowsInsecureCookie()).toBe(false);
      expect(sessionCookieName()).toBe("__Host-bp_session");
    }
  );

  it("is on only for an exact 1", () => {
    process.env.COOKIE_ALLOW_INSECURE = "1";
    expect(allowsInsecureCookie()).toBe(true);
  });
});

describe("cookie name and attributes", () => {
  const expiresAt = new Date(Date.now() + 30 * DAY_MS);

  it("uses the __Host- prefix and Secure by default", () => {
    const cookie = buildSessionCookie("cps_abc", expiresAt);

    expect(sessionCookieName()).toBe("__Host-bp_session");
    expect(cookie.startsWith("__Host-bp_session=cps_abc; ")).toBe(true);
    expect(cookie).toContain("; Secure");
    expect(cookie).toContain("; HttpOnly");
    expect(cookie).toContain("; SameSite=Lax");
    expect(cookie).toContain("; Path=/");
    expect(cookie).not.toContain("Domain=");
  });

  it("drops the prefix and Secure when the operator opted in", () => {
    process.env.COOKIE_ALLOW_INSECURE = "1";
    const cookie = buildSessionCookie("cps_abc", expiresAt);

    expect(sessionCookieName()).toBe("bp_session");
    expect(cookie.startsWith("bp_session=cps_abc; ")).toBe(true);
    expect(cookie).not.toContain("Secure");
    expect(cookie).toContain("; HttpOnly");
    expect(cookie).toContain("; SameSite=Lax");
  });

  it("carries Max-Age derived from the row expiry", () => {
    const cookie = buildSessionCookie("cps_abc", new Date(Date.now() + 60_000));
    expect(cookie).toMatch(/; Max-Age=(59|60);/);
  });

  it("clears both names on logout and keeps Secure on the prefixed one", () => {
    process.env.COOKIE_ALLOW_INSECURE = "1";
    const cleared = clearSessionCookies();

    expect(cleared).toHaveLength(2);
    expect(cleared[0]).toContain("__Host-bp_session=;");
    expect(cleared[0]).toContain("; Secure");
    expect(cleared[1]).toContain("bp_session=;");
    expect(cleared.every((c) => c.includes("Max-Age=0"))).toBe(true);
  });

  it("expires only the inactive name on login", () => {
    expect(legacySessionCookies()).toEqual([
      expect.stringContaining("bp_session=;"),
    ]);
    expect(legacySessionCookies()[0]).not.toContain("__Host-");
  });
});

describe("reading the cookie header", () => {
  it("reads the prefixed name in secure mode", () => {
    expect(readSessionCookie("theme=dark; __Host-bp_session=cps_abc")).toBe("cps_abc");
  });

  it("refuses an unprefixed cookie in secure mode even when present", () => {
    expect(readSessionCookie("bp_session=cps_abc")).toBeNull();
  });

  it("refuses a prefixed cookie in insecure mode", () => {
    process.env.COOKIE_ALLOW_INSECURE = "1";
    expect(readSessionCookie("__Host-bp_session=cps_abc")).toBeNull();
    expect(readSessionCookie("bp_session=cps_abc")).toBe("cps_abc");
  });

  it("is null for an absent or empty cookie", () => {
    expect(readSessionCookie(null)).toBeNull();
    expect(readSessionCookie("__Host-bp_session=")).toBeNull();
  });
});

describe("startup validation", () => {
  it("passes when the flag is off", () => {
    expect(() => assertSessionConfig()).not.toThrow();
  });

  it("refuses to boot with the flag on and no APP_ORIGIN", () => {
    process.env.COOKIE_ALLOW_INSECURE = "1";
    expect(() => assertSessionConfig()).toThrow(/APP_ORIGIN/);
  });

  it("warns rather than throws once APP_ORIGIN is set", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    process.env.COOKIE_ALLOW_INSECURE = "1";
    process.env.APP_ORIGIN = "http://192.168.1.10:3000";

    expect(() => assertSessionConfig()).not.toThrow();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("parses a comma-separated allowlist", () => {
    process.env.APP_ORIGIN = "https://a.example.com, https://b.example.com/ ,";
    expect(appOrigins()).toEqual(["https://a.example.com", "https://b.example.com"]);
  });
});

describe("provenance", () => {
  it("passes a safe method with no provenance headers at all", () => {
    expect(checkProvenance(mutating({}, "GET")).ok).toBe(true);
  });

  it("passes Sec-Fetch-Site: same-origin", () => {
    expect(checkProvenance(mutating({ "sec-fetch-site": "same-origin" })).ok).toBe(true);
  });

  it("passes Sec-Fetch-Site: none", () => {
    expect(checkProvenance(mutating({ "sec-fetch-site": "none" })).ok).toBe(true);
  });

  it.each(["cross-site", "same-site"])("refuses Sec-Fetch-Site: %s", (site) => {
    expect(checkProvenance(mutating({ "sec-fetch-site": site }))).toEqual({
      ok: false,
      reason: "cross-site",
    });
  });

  it("ignores Origin entirely when Sec-Fetch-Site says cross-site", () => {
    process.env.APP_ORIGIN = "https://evil.example.com";
    expect(
      checkProvenance(
        mutating({ "sec-fetch-site": "cross-site", origin: "https://evil.example.com" })
      ).ok
    ).toBe(false);
  });

  it("falls back to Origin against APP_ORIGIN", () => {
    process.env.APP_ORIGIN = "https://app.example.com";
    expect(checkProvenance(mutating({ origin: "https://app.example.com" })).ok).toBe(true);
  });

  it("refuses an Origin outside the allowlist", () => {
    process.env.APP_ORIGIN = "https://app.example.com";
    expect(checkProvenance(mutating({ origin: "https://evil.example.com" }))).toEqual({
      ok: false,
      reason: "origin-mismatch",
    });
  });

  it("refuses an Origin when APP_ORIGIN is unset", () => {
    expect(checkProvenance(mutating({ origin: "https://app.example.com" })).ok).toBe(false);
  });

  it("refuses when both signals are absent", () => {
    expect(checkProvenance(mutating())).toEqual({ ok: false, reason: "no-provenance" });
  });

  it("does not let x-forwarded-host stand in for either signal", () => {
    process.env.APP_ORIGIN = "https://app.example.com";
    expect(
      checkProvenance(mutating({ "x-forwarded-host": "app.example.com" })).ok
    ).toBe(false);
    expect(
      checkProvenance(
        mutating({ "x-forwarded-host": "app.example.com", origin: "https://evil.example.com" })
      ).ok
    ).toBe(false);
  });

  it.each(["PUT", "PATCH", "DELETE"])("applies to %s as well", (method) => {
    expect(checkProvenance(mutating({}, method)).ok).toBe(false);
  });
});

describe("createSession", () => {
  it("mints a cps_ token, stores only its hash and caps the row at 90 days", async () => {
    const before = Date.now();
    const created = await createSession({ userId: "user-1", userAgent: "UA", ip: "1.2.3.4" });

    expect(created.token).toMatch(/^cps_[0-9a-f]{64}$/);
    const doc = create.mock.calls[0][0];
    expect(doc.tokenHash).not.toContain(created.token);
    expect(doc.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(doc.absoluteExpiresAt.getTime() - before).toBeGreaterThanOrEqual(90 * DAY_MS - 1000);
    expect(doc.expiresAt.getTime()).toBeLessThanOrEqual(doc.absoluteExpiresAt.getTime());
    expect(created.expiresAt).toEqual(doc.expiresAt);
  });
});

describe("resolveSession", () => {
  it("is null when nothing hashes to the token", async () => {
    expect(await resolveSession("cps_nope")).toBeNull();
  });

  it("refuses a session past expiresAt", async () => {
    found(row({ expiresAt: new Date(Date.now() - 1000) }));
    expect(await resolveSession("cps_abc")).toBeNull();
    expect(updateOne).not.toHaveBeenCalled();
  });

  it("refuses a session past absoluteExpiresAt even with a live expiresAt", async () => {
    found(
      row({
        expiresAt: new Date(Date.now() + 10 * DAY_MS),
        absoluteExpiresAt: new Date(Date.now() - 1000),
      })
    );
    expect(await resolveSession("cps_abc")).toBeNull();
    expect(updateOne).not.toHaveBeenCalled();
  });

  it("does not write when the window is less than the throttle from full", async () => {
    found(row({ expiresAt: new Date(Date.now() + SESSION_IDLE_TTL_MS - 60_000) }));

    const resolved = await resolveSession("cps_abc");

    expect(resolved?.sessionId).toBe("session-1");
    expect(resolved?.userId).toBe("user-1");
    expect(updateOne).not.toHaveBeenCalled();
  });

  it("does not write at exactly the throttle boundary", async () => {
    // Frozen: the row is built from one Date.now() and the boundary is evaluated from another, and
    // the comparison is a strict >. Any real time passing between the two puts the row past the
    // boundary and it slides — which passed locally and failed on slower CI.
    vi.useFakeTimers();
    try {
      found(
        row({ expiresAt: new Date(Date.now() + SESSION_IDLE_TTL_MS - SESSION_SLIDE_THROTTLE_MS) })
      );
      await resolveSession("cps_abc");
      expect(updateOne).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("slides one millisecond past the boundary", async () => {
    vi.useFakeTimers();
    try {
      found(
        row({
          expiresAt: new Date(Date.now() + SESSION_IDLE_TTL_MS - SESSION_SLIDE_THROTTLE_MS - 1),
        })
      );
      await resolveSession("cps_abc");
      expect(updateOne).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("slides once the window is more than the throttle from full", async () => {
    const before = Date.now();
    found(row({ expiresAt: new Date(before + 10 * DAY_MS) }));

    const resolved = await resolveSession("cps_abc");

    expect(updateOne).toHaveBeenCalledTimes(1);
    const [filter, update] = updateOne.mock.calls[0];
    expect(filter).toEqual({ _id: "session-1" });
    expect(update.$set.expiresAt.getTime() - before).toBeGreaterThanOrEqual(
      SESSION_IDLE_TTL_MS - 1000
    );
    expect(update.$set.lastUsedAt).toBeInstanceOf(Date);
    expect(resolved?.expiresAt).toEqual(update.$set.expiresAt);
  });

  it("clamps the slide to absoluteExpiresAt", async () => {
    const cap = new Date(Date.now() + 2 * DAY_MS);
    found(row({ expiresAt: new Date(Date.now() + 60 * 60 * 1000), absoluteExpiresAt: cap }));

    const resolved = await resolveSession("cps_abc");

    const written = updateOne.mock.calls[0][1].$set.expiresAt as Date;
    expect(written.getTime()).toBe(cap.getTime());
    expect(written.getTime()).toBeLessThanOrEqual(cap.getTime());
    expect(resolved?.expiresAt.getTime()).toBe(cap.getTime());
  });

  it("never slides a session already sitting on its cap", async () => {
    const cap = new Date(Date.now() + 2 * DAY_MS);
    found(row({ expiresAt: cap, absoluteExpiresAt: cap }));

    await resolveSession("cps_abc");

    expect(updateOne).not.toHaveBeenCalled();
  });
});

describe("revocation", () => {
  it("deletes the row behind a cookie and reports the miss", async () => {
    expect(await revokeSession("cps_abc")).toBe(true);
    expect(deleteOne.mock.calls[0][0].tokenHash).toMatch(/^[0-9a-f]{64}$/);

    deleteOne.mockResolvedValue({ deletedCount: 0 });
    expect(await revokeSession("cps_abc")).toBe(false);
  });

  it("deletes every session of a user", async () => {
    expect(await revokeUserSessions("user-1")).toBe(3);
    expect(deleteMany).toHaveBeenCalledWith({ user: "user-1" });
  });

  it("spares the calling session only when one was given", async () => {
    await revokeUserSessions("user-1", "session-1");
    expect(deleteMany).toHaveBeenCalledWith({ user: "user-1", _id: { $ne: "session-1" } });

    deleteMany.mockClear();
    await revokeUserSessions("user-1", undefined);
    expect(deleteMany).toHaveBeenCalledWith({ user: "user-1" });
  });
});

describe("readSessionCookie — duplicate names", () => {
  it("takes neither when the header carries two cookies of the active name", () => {
    // Two of one name means one was set for a parent domain — the shadowing __Host- prevents and
    // the unprefixed name cannot. Which one wins is browser ordering, so trusting either is a
    // coin flip on whose session the request runs as.
    const header = `__Host-bp_session=attacker; __Host-bp_session=victim`;
    expect(readSessionCookie(header)).toBeNull();
  });

  it("still reads a single cookie sitting among others", () => {
    expect(readSessionCookie("theme=dark; __Host-bp_session=live; other=1")).toBe("live");
  });
});

describe("assertSessionConfig — insecure mode against an https origin", () => {
  it("refuses to start rather than downgrade the cookie on a TLS deployment", () => {
    process.env.COOKIE_ALLOW_INSECURE = "1";
    process.env.APP_ORIGIN = "https://board.example.com";

    expect(() => assertSessionConfig()).toThrow(/https:\/\/board\.example\.com/);
  });

  it("allows the flag alongside a plain-http origin, which is what compose ships", () => {
    process.env.COOKIE_ALLOW_INSECURE = "1";
    process.env.APP_ORIGIN = "http://localhost:3000";

    expect(() => assertSessionConfig()).not.toThrow();
  });

  it("refuses a mixed list containing an https origin", () => {
    process.env.COOKIE_ALLOW_INSECURE = "1";
    process.env.APP_ORIGIN = "http://localhost:3000,https://board.example.com";

    expect(() => assertSessionConfig()).toThrow(/https:\/\/board\.example\.com/);
  });
});

describe("assertSessionConfig — APP_ORIGIN must be plain http in insecure mode", () => {
  it("refuses a schemeless origin, which a blocklist on https would have waved through", () => {
    process.env.COOKIE_ALLOW_INSECURE = "1";
    process.env.APP_ORIGIN = "app.example.com";

    expect(() => assertSessionConfig()).toThrow(/http:\/\/ origin/);
  });

  it("refuses any non-http scheme", () => {
    process.env.COOKIE_ALLOW_INSECURE = "1";
    process.env.APP_ORIGIN = "ws://app.example.com";

    expect(() => assertSessionConfig()).toThrow(/http:\/\/ origin/);
  });
});

describe("buildSessionCookie — Max-Age follows the absolute cap", () => {
  it("outlives the idle window, so daily use cannot be evicted by the browser at day 30", () => {
    const absolute = new Date(Date.now() + SESSION_ABSOLUTE_TTL_MS);
    const cookie = buildSessionCookie("cps_abc", absolute);
    const maxAge = Number(/Max-Age=(\d+)/.exec(cookie)![1]);

    expect(maxAge).toBeGreaterThan(SESSION_IDLE_TTL_MS / 1000);
    expect(maxAge).toBeLessThanOrEqual(SESSION_ABSOLUTE_TTL_MS / 1000);
  });
});
