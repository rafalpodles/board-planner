import { describe, it, expect, vi, beforeEach } from "vitest";

const verifyCredentials = vi.fn();
const oauthClientFindOne = vi.fn();
const oauthConsentCreate = vi.fn();
const oauthConsentFindOne = vi.fn();
const oauthCodeCreate = vi.fn();
const userFindById = vi.fn();
const resolveSession = vi.fn();
const createSession = vi.fn();
const oauthConsentDeleteOne = vi.fn();
// A permanently empty board list cannot exercise the line that narrows a grant, which is the
// privilege-limiting line of the whole feature (BP-383 review).
let projects: { _id: string; name: string; key: string }[] = [];

vi.mock("@/lib/db", () => ({ connectDB: vi.fn() }));
vi.mock("@/models/rateLimit", async () => {
  const { inMemoryRateLimitModel } = await import("@/lib/rate-limit-test-store");
  return { RateLimit: inMemoryRateLimitModel() };
});

vi.mock("@/lib/auth", () => ({ verifyCredentials, getClientIp: () => "203.0.113.7" }));
vi.mock("@/lib/grants", () => ({ accessibleProjectIds: vi.fn().mockResolvedValue(null) }));
vi.mock("@/models/oauthClient", () => ({ OAuthClient: { findOne: oauthClientFindOne } }));
vi.mock("@/models/oauthCode", () => ({ OAuthCode: { create: oauthCodeCreate } }));
vi.mock("@/models/oauthConsent", () => ({
  OAuthConsent: {
    create: oauthConsentCreate,
    findOne: oauthConsentFindOne,
    deleteOne: oauthConsentDeleteOne,
  },
}));
vi.mock("@/models/user", () => ({ User: { findById: userFindById } }));
vi.mock("@/lib/security-mail", () => ({ notifyCredentialCreated: vi.fn() }));
// Partial: the route's own provenance gate is the real checkProvenance, and the cookie is read by
// the real reader — only the session lookup is stubbed.
vi.mock("@/lib/session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/session")>()),
  resolveSession,
  createSession,
}));
vi.mock("@/models/project", () => ({
  Project: {
    find: () => ({ select: () => ({ sort: () => ({ lean: async () => projects }) }) }),
  },
}));

const { GET, POST } = await import("./route");
const { resetRateLimits, ANONYMOUS_ACCOUNT_ATTEMPTS } = await import("@/lib/rate-limit");
const { sessionCookieName } = await import("@/lib/session");

const REDIRECT_URI = "https://client.example/callback";
const USER = { _id: "u1", username: "victim", role: "member" };

function login(username: string, password = "secret") {
  const body = new URLSearchParams({
    phase: "login",
    client_id: "c1",
    redirect_uri: REDIRECT_URI,
    state: "s",
    code_challenge: "challenge",
    code_challenge_method: "S256",
    response_type: "code",
    scope: "mcp",
    username,
    password,
  });
  return new Request("http://localhost/oauth/authorize", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      // What a browser sends posting the sign-in form this endpoint itself served
      "sec-fetch-site": "same-origin",
    },
    body,
  });
}

async function attempt(username: string): Promise<string> {
  const res = await POST(login(username));
  // A successful login is a 303 back to the authorize URL, so the body says nothing; the tests
  // below read it for the refusals and use `signedIn` for the successes.
  return res.status === 303 ? "Signed in" : res.text();
}

async function signedIn(username: string): Promise<Response> {
  return POST(login(username));
}

beforeEach(async () => {
  vi.clearAllMocks();
  await resetRateLimits();
  projects = [];
  oauthConsentDeleteOne.mockResolvedValue({ deletedCount: 1 });
  createSession.mockResolvedValue({
    token: "cps_fresh",
    sessionId: "s1",
    expiresAt: new Date(Date.now() + 60_000),
    absoluteExpiresAt: new Date(Date.now() + 60_000),
  });
  oauthClientFindOne.mockResolvedValue({
    clientId: "c1",
    clientName: "Some App",
    redirectUris: [REDIRECT_URI],
  });
  verifyCredentials.mockResolvedValue(null);
});

describe("POST /oauth/authorize login phase", () => {
  it("bounds guessing when no client identity is available", async () => {
    // Without a proxy header every caller shares the account key, so a refusal there can be aimed
    // at somebody else — but leaving it unchecked left login entirely unthrottled, which is worse.
    // The threshold is raised rather than removed, and BP-353 gave the person aimed at a way out:
    // any password change clears the counter.
    for (let i = 0; i < ANONYMOUS_ACCOUNT_ATTEMPTS; i++) await attempt("locked");

    verifyCredentials.mockClear();
    verifyCredentials.mockResolvedValue(USER);
    const body = await attempt("locked");

    expect(body).toContain("Too many failed attempts.");
    // The point of refusing before verification: the server stops doing bcrypt work
    expect(verifyCredentials).not.toHaveBeenCalled();
  });

  it("leaves a different account alone", async () => {
    for (let i = 0; i < ANONYMOUS_ACCOUNT_ATTEMPTS; i++) await attempt("locked");

    verifyCredentials.mockResolvedValue(USER);
    expect(await attempt("bystander")).toContain("Signed in");
  });

  it("locks out one username at a time", async () => {
    for (let i = 0; i < 11; i++) await attempt("sprayed");

    verifyCredentials.mockResolvedValue(USER);
    const body = await attempt("bystander");

    expect(body).toContain("Signed in");
  });

  it("clears the counter on a successful login", async () => {
    for (let i = 0; i < 9; i++) await attempt("recovering");

    verifyCredentials.mockResolvedValue(USER);
    expect(await attempt("recovering")).toContain("Signed in");

    verifyCredentials.mockResolvedValue(null);
    for (let i = 0; i < 9; i++) await attempt("recovering");

    verifyCredentials.mockResolvedValue(USER);
    expect(await attempt("recovering")).toContain("Signed in");
  });

  // A consent page rendered straight from the password POST is a POST history entry, and with
  // no-store keeping it out of the back/forward cache, Back re-fetches it — replaying the password
  // from the browser's own buffer. Post/Redirect/Get leaves a GET entry with nothing to replay.
  it("answers a correct password with a session and a redirect, not with the consent page", async () => {
    verifyCredentials.mockResolvedValue(USER);

    const response = await signedIn("happy");

    expect(response.status).toBe(303);
    expect(response.headers.get("set-cookie")).toContain("cps_fresh");
    expect(response.headers.get("location")).toContain("/oauth/authorize?");
    expect(response.headers.get("location")).toContain("code_challenge=challenge");
    expect(response.headers.get("location")).not.toContain("prompt=login");
    expect(createSession).toHaveBeenCalledTimes(1);
    // The ticket is minted by the GET that follows, where it can be bound to that session
    expect(oauthConsentCreate).not.toHaveBeenCalled();
  });

  // BP-355. This endpoint reaches the same throttle counters as /api/auth/login, under the same
  // keys, and a client can be registered at the unauthenticated /oauth/register — so without the
  // refusal the login route makes, this is the quieter way to spend somebody else's budget.
  describe("provenance", () => {
    function crossSite(headers: Record<string, string>) {
      const body = new URLSearchParams({
        client_id: "client-1",
        redirect_uri: "https://client.example.com/cb",
        code_challenge: "a".repeat(43),
        code_challenge_method: "S256",
        response_type: "code",
        scope: "mcp",
        username: "rafal",
        password: "guess",
      });
      return new Request("http://localhost/oauth/authorize", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
        body,
      });
    }

    // BP-444: same-origin, so it is past the gate above, and `formData()` throws on a body that is
    // not a form — a 500 for what is a plain refusal.
    it("refuses a same-origin post whose body is not a form", async () => {
      verifyCredentials.mockResolvedValue(USER);

      const response = await POST(
        new Request("http://localhost/oauth/authorize", {
          method: "POST",
          headers: { "content-type": "application/json", "sec-fetch-site": "same-origin" },
          body: JSON.stringify({ username: "rafal", password: "guess" }),
        })
      );

      expect(response.status).toBe(400);
      expect(verifyCredentials).not.toHaveBeenCalled();
    });

    it("refuses a cross-site post before verifying anything", async () => {
      verifyCredentials.mockResolvedValue(USER);

      const response = await POST(crossSite({ "sec-fetch-site": "cross-site" }));

      expect(response.status).toBe(403);
      expect(verifyCredentials).not.toHaveBeenCalled();
    });

    // The gate has to cover BOTH phases. Neither shipped test set `phase`, so both landed on the
    // login branch and consent was never exercised (BP-355 review).
    it("refuses a cross-site consent submission too", async () => {
      const body = new URLSearchParams({ phase: "consent", ticket: "t1", decision: "allow" });
      const response = await POST(
        new Request("http://localhost/oauth/authorize", {
          method: "POST",
          headers: {
            "content-type": "application/x-www-form-urlencoded",
            "sec-fetch-site": "cross-site",
          },
          body,
        })
      );

      expect(response.status).toBe(403);
      expect(oauthConsentCreate).not.toHaveBeenCalled();
    });

    it("refuses a post carrying neither Sec-Fetch-Site nor Origin", async () => {
      verifyCredentials.mockResolvedValue(USER);

      const response = await POST(crossSite({}));

      expect(response.status).toBe(403);
      expect(verifyCredentials).not.toHaveBeenCalled();
    });
  });
});

const AUTH_QUERY = {
  client_id: "c1",
  redirect_uri: REDIRECT_URI,
  state: "s",
  code_challenge: "challenge",
  code_challenge_method: "S256",
  response_type: "code",
  scope: "mcp",
};

function authorizeGet(extra: Record<string, string> = {}, headers: HeadersInit = {}) {
  const sp = new URLSearchParams({ ...AUTH_QUERY, ...extra });
  return new Request(`http://localhost/oauth/authorize?${sp.toString()}`, { headers });
}

function sessionCookie(): Record<string, string> {
  return { cookie: `${sessionCookieName()}=cps_live-token` };
}

describe("GET /oauth/authorize", () => {
  beforeEach(() => {
    resolveSession.mockResolvedValue(null);
    userFindById.mockResolvedValue(USER);
  });

  it("asks for a password when nothing says who this is", async () => {
    const body = await (await GET(authorizeGet())).text();

    expect(body).toContain("Sign in to");
    expect(oauthConsentCreate).not.toHaveBeenCalled();
  });

  // BP-383: the browser already holds a session cookie, and typing the password again proves
  // nothing that cookie has not already proven.
  it("takes the browser session instead of asking for the password again", async () => {
    resolveSession.mockResolvedValue({ userId: "u1", sessionId: "s1" });

    const body = await (await GET(authorizeGet({}, sessionCookie()))).text();

    expect(body).toContain("Grant access");
    expect(body).toContain("victim");
    expect(body).not.toContain("Sign in to");
    expect(oauthConsentCreate).toHaveBeenCalledTimes(1);
  });

  // An account with no boards cannot fill a narrow grant, and the answer to that dead end is not to
  // pre-tick the widest credential the account can issue (BP-383 review).
  it("offers the wide grant to an account with no boards without pre-selecting it", async () => {
    resolveSession.mockResolvedValue({ userId: "u1", sessionId: "s1" });
    projects = [];

    const body = await (await GET(authorizeGet({}, sessionCookie()))).text();

    expect(body).toContain('value="limited" disabled');
    expect(body).toContain('value="all"> All projects');
    expect(body).not.toContain('value="all" checked');
  });

  // Third iteration of this counter and the first test of it. The point is the dimension: one
  // account exhausting its budget must not refuse a second account, which is what an
  // address-keyed counter does behind a proxy or a NAT (BP-383 review).
  it("bounds ticket issuance per account, without touching another account", async () => {
    resolveSession.mockResolvedValue({ userId: "u1", sessionId: "s1" });
    for (let i = 0; i < 61; i++) await GET(authorizeGet({}, sessionCookie()));

    const exhausted = await GET(authorizeGet({}, sessionCookie()));
    expect(exhausted.status).toBe(429);

    resolveSession.mockResolvedValue({ userId: "u2", sessionId: "s2" });
    const bystander = await GET(authorizeGet({}, sessionCookie()));
    expect(bystander.status).toBe(200);
    expect(await bystander.text()).toContain("Grant access");
  });

  it("asks anyway when the request says prompt=login", async () => {
    resolveSession.mockResolvedValue({ userId: "u1", sessionId: "s1" });

    const body = await (await GET(authorizeGet({ prompt: "login" }, sessionCookie()))).text();

    expect(body).toContain("Sign in to");
    expect(oauthConsentCreate).not.toHaveBeenCalled();
  });

  // An access token belongs to an application. Letting one stand in for the person at the keyboard
  // would let an application mint itself a second, wider credential without anybody present.
  it("does not let a bearer token stand in for the person authorizing", async () => {
    // The bearer names one account and the cookie another. If the header were read at all, the
    // page would be built for whoever it resolved to.
    resolveSession.mockResolvedValue({ userId: "u1", sessionId: "s1" });

    const body = await (
      await GET(authorizeGet({}, { ...sessionCookie(), authorization: "Bearer cpat_admin" }))
    ).text();

    expect(body).toContain("victim");

    resolveSession.mockResolvedValue(null);
    const bearerOnly = await (
      await GET(authorizeGet({}, { authorization: "Bearer cpat_admin" }))
    ).text();

    expect(bearerOnly).toContain("Sign in to");
    expect(oauthConsentCreate).toHaveBeenCalledTimes(1);
  });

  it("refuses an expired or unknown session quietly", async () => {
    resolveSession.mockResolvedValue(null);

    const body = await (await GET(authorizeGet({}, sessionCookie()))).text();

    expect(body).toContain("Sign in to");
  });
});

describe("POST /oauth/authorize consent phase", () => {
  beforeEach(() => {
    oauthConsentFindOne.mockResolvedValue({
      _id: "cs1",
      clientId: "c1",
      user: "u1",
      session: "s1",
      redirectUri: REDIRECT_URI,
      codeChallenge: "challenge",
      state: "s",
      scope: "mcp",
      expiresAt: new Date(Date.now() + 60_000),
    });
    resolveSession.mockResolvedValue({ userId: "u1", sessionId: "s1" });
    userFindById.mockResolvedValue(USER);
    oauthCodeCreate.mockResolvedValue({});
  });

  function consent(fields: Record<string, string>, headers: Record<string, string> = {}) {
    return new Request("http://localhost/oauth/authorize", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "sec-fetch-site": "same-origin",
        ...sessionCookie(),
        ...headers,
      },
      body: new URLSearchParams({
        phase: "consent",
        ticket: "t1",
        decision: "allow",
        ...fields,
      }),
    });
  }

  // BP-383: `form-action 'self'` is enforced across the redirect chain, so answering the consent
  // POST with a 302 to the client had the browser block the submission outright — the Authorize
  // button did nothing but log a CSP violation. A page that navigates itself is not a submission.
  it("hands the code over by navigating, not by redirecting the form", async () => {
    const response = await POST(consent({ access: "all" }));
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("location")).toBeNull();
    expect(body).toMatch(
      /<meta http-equiv="refresh" content="0;url=https:\/\/client\.example\/callback\?code=cpac_/
    );
    expect(body).toMatch(
      /<a id="return" href="https:\/\/client\.example\/callback\?code=cpac_[^"]+&amp;state=s"/
    );
    expect(oauthCodeCreate).toHaveBeenCalledTimes(1);
  });

  it("keeps the whole account off the grant unless it was asked for", async () => {
    projects = [{ _id: "p1", name: "Orbit", key: "ORB" }];
    await POST(consent({ access: "all" }));
    expect(oauthCodeCreate.mock.calls[0][0].allowedProjects).toEqual([]);

    oauthCodeCreate.mockClear();
    const body = await (await POST(consent({}))).text();

    expect(body).toContain("Select at least one project");
    expect(oauthCodeCreate).not.toHaveBeenCalled();
  });

  // Only "all" is the wide grant. Anything else — a typo, a hand-built form, a value from a future
  // version of this page — has to land on the narrow branch rather than skipping the filter.
  it("treats an access value it does not recognise as the narrow grant", async () => {
    projects = [{ _id: "p1", name: "Orbit", key: "ORB" }];
    const body = await (await POST(consent({ access: "everything" }))).text();

    expect(body).toContain("Select at least one project");
    expect(oauthCodeCreate).not.toHaveBeenCalled();
  });

  it("narrows the grant to the boards the account can actually reach", async () => {
    projects = [
      { _id: "p1", name: "Orbit", key: "ORB" },
      { _id: "p2", name: "Mobile", key: "MOB" },
    ];
    const body = new URLSearchParams({
      phase: "consent",
      ticket: "t1",
      decision: "allow",
      access: "limited",
    });
    body.append("projects", "p1");
    body.append("projects", "p-not-mine");

    await POST(
      new Request("http://localhost/oauth/authorize", {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          "sec-fetch-site": "same-origin",
          ...sessionCookie(),
        },
        body,
      })
    );

    expect(oauthCodeCreate.mock.calls[0][0].allowedProjects).toEqual(["p1"]);
  });

  // BP-383 review: the ticket is now minted on a GET and rendered into a page a browser will
  // restore from history, so whoever redeems it has to be the session it was issued to.
  it("refuses a ticket redeemed by a different session", async () => {
    oauthConsentFindOne.mockResolvedValue({
      _id: "cs1",
      clientId: "c1",
      user: "u1",
      session: "s1",
      redirectUri: REDIRECT_URI,
      codeChallenge: "challenge",
      state: "s",
      scope: "mcp",
      expiresAt: new Date(Date.now() + 60_000),
    });
    resolveSession.mockResolvedValue({ userId: "u2", sessionId: "s2" });

    const response = await POST(
      new Request("http://localhost/oauth/authorize", {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          "sec-fetch-site": "same-origin",
          ...sessionCookie(),
        },
        body: new URLSearchParams({
          phase: "consent",
          ticket: "t1",
          decision: "allow",
          access: "all",
        }),
      })
    );

    expect(response.status).toBe(403);
    expect(oauthCodeCreate).not.toHaveBeenCalled();
  });

  it("lets the session it was issued to redeem it", async () => {
    oauthConsentFindOne.mockResolvedValue({
      _id: "cs1",
      clientId: "c1",
      user: "u1",
      session: "s1",
      redirectUri: REDIRECT_URI,
      codeChallenge: "challenge",
      state: "s",
      scope: "mcp",
      expiresAt: new Date(Date.now() + 60_000),
    });
    resolveSession.mockResolvedValue({ userId: "u1", sessionId: "s1" });

    const response = await POST(
      new Request("http://localhost/oauth/authorize", {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          "sec-fetch-site": "same-origin",
          ...sessionCookie(),
        },
        body: new URLSearchParams({
          phase: "consent",
          ticket: "t1",
          decision: "allow",
          access: "all",
        }),
      })
    );

    expect(response.status).toBe(200);
    expect(oauthCodeCreate).toHaveBeenCalledTimes(1);
  });

  // RFC 6749 4.1.2.1 — refusing is an answer the client is owed
  it("tells the client when the person says no", async () => {
    const body = await (await POST(consent({ decision: "deny", access: "all" }))).text();

    expect(body).toMatch(
      /href="https:\/\/client\.example\/callback\?error=access_denied&amp;state=s"/
    );
    expect(oauthCodeCreate).not.toHaveBeenCalled();
  });

  it("refuses a session-bound ticket presented with no session at all", async () => {
    const response = await POST(
      new Request("http://localhost/oauth/authorize", {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          "sec-fetch-site": "same-origin",
        },
        body: new URLSearchParams({
          phase: "consent",
          ticket: "t1",
          decision: "allow",
          access: "all",
        }),
      })
    );

    expect(response.status).toBe(403);
    expect(oauthCodeCreate).not.toHaveBeenCalled();
  });

  // A row written before the binding existed carries no session, and must be refused rather than
  // waved through on a falsy check.
  it("refuses a ticket that names no session", async () => {
    oauthConsentFindOne.mockResolvedValue({
      _id: "cs1",
      clientId: "c1",
      user: "u1",
      session: null,
      redirectUri: REDIRECT_URI,
      codeChallenge: "challenge",
      state: "s",
      scope: "mcp",
      expiresAt: new Date(Date.now() + 60_000),
    });

    const response = await POST(consent({ access: "all" }));

    expect(response.status).toBe(403);
    expect(oauthCodeCreate).not.toHaveBeenCalled();
  });

  // Two submissions of one ticket that interleave must not mint two redeemable codes
  it("mints nothing when the ticket was already claimed", async () => {
    oauthConsentDeleteOne.mockResolvedValue({ deletedCount: 0 });

    const body = await (await POST(consent({ access: "all" }))).text();

    expect(body).toContain("already completed");
    expect(oauthCodeCreate).not.toHaveBeenCalled();
  });

  // Only an explicit allow grants, for the same reason only an explicit "all" widens
  it("does not grant a submission that carries no decision", async () => {
    const body = await (
      await POST(
        new Request("http://localhost/oauth/authorize", {
          method: "POST",
          headers: {
            "content-type": "application/x-www-form-urlencoded",
            "sec-fetch-site": "same-origin",
            ...sessionCookie(),
          },
          body: new URLSearchParams({ phase: "consent", ticket: "t1", access: "all" }),
        })
      )
    ).text();

    expect(body).toContain("error=access_denied");
    expect(oauthCodeCreate).not.toHaveBeenCalled();
  });

  it("refuses an expired ticket", async () => {
    oauthConsentFindOne.mockResolvedValue({
      _id: "cs1",
      clientId: "c1",
      user: "u1",
      session: "s1",
      redirectUri: REDIRECT_URI,
      codeChallenge: "challenge",
      state: "s",
      scope: "mcp",
      expiresAt: new Date(Date.now() - 1),
    });

    const body = await (await POST(consent({ access: "all" }))).text();

    expect(body).toContain("Your session expired");
    expect(oauthCodeCreate).not.toHaveBeenCalled();
  });

  it("refuses when the client was deleted between the screens", async () => {
    oauthClientFindOne.mockResolvedValue(null);

    const body = await (await POST(consent({ access: "all" }))).text();

    expect(body).toContain("Client is no longer valid");
    expect(oauthCodeCreate).not.toHaveBeenCalled();
  });

  it("refuses when the account was deleted between the screens", async () => {
    userFindById.mockResolvedValue(null);

    const body = await (await POST(consent({ access: "all" }))).text();

    expect(body).toContain("Account no longer exists");
    expect(oauthCodeCreate).not.toHaveBeenCalled();
  });
});
