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
      "sec-fetch-site": "same-origin",
    },
    body,
  });
}

async function attempt(username: string): Promise<string> {
  const res = await POST(login(username));
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
    for (let i = 0; i < ANONYMOUS_ACCOUNT_ATTEMPTS; i++) await attempt("locked");

    verifyCredentials.mockClear();
    verifyCredentials.mockResolvedValue(USER);
    const body = await attempt("locked");

    expect(body).toContain("Too many failed attempts.");
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

  it("answers a correct password with a session and a redirect, not with the consent page", async () => {
    verifyCredentials.mockResolvedValue(USER);

    const response = await signedIn("happy");

    expect(response.status).toBe(303);
    expect(response.headers.get("set-cookie")).toContain("cps_fresh");
    expect(response.headers.get("location")).toContain("/oauth/authorize?");
    expect(response.headers.get("location")).toContain("code_challenge=challenge");
    expect(response.headers.get("location")).not.toContain("prompt=login");
    expect(createSession).toHaveBeenCalledTimes(1);
    expect(oauthConsentCreate).not.toHaveBeenCalled();
  });

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

  it("takes the browser session instead of asking for the password again", async () => {
    resolveSession.mockResolvedValue({ userId: "u1", sessionId: "s1" });

    const body = await (await GET(authorizeGet({}, sessionCookie()))).text();

    expect(body).toContain("Grant access");
    expect(body).toContain("victim");
    expect(body).not.toContain("Sign in to");
    expect(oauthConsentCreate).toHaveBeenCalledTimes(1);
  });

  it("offers the wide grant to an account with no boards without pre-selecting it", async () => {
    resolveSession.mockResolvedValue({ userId: "u1", sessionId: "s1" });
    projects = [];

    const body = await (await GET(authorizeGet({}, sessionCookie()))).text();

    expect(body).toContain('value="limited" disabled');
    expect(body).toContain('value="all"> All projects');
    expect(body).not.toContain('value="all" checked');
  });

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

  it("does not let a bearer token stand in for the person authorizing", async () => {
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

  it("mints nothing when the ticket was already claimed", async () => {
    oauthConsentDeleteOne.mockResolvedValue({ deletedCount: 0 });

    const body = await (await POST(consent({ access: "all" }))).text();

    expect(body).toContain("already completed");
    expect(oauthCodeCreate).not.toHaveBeenCalled();
  });

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
