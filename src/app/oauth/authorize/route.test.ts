import { describe, it, expect, vi, beforeEach } from "vitest";

const verifyCredentials = vi.fn();
const oauthClientFindOne = vi.fn();
const oauthConsentCreate = vi.fn();
const oauthConsentFindOne = vi.fn();
const oauthCodeCreate = vi.fn();
const userFindById = vi.fn();
const resolveSession = vi.fn();

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
    deleteOne: vi.fn(),
  },
}));
vi.mock("@/models/user", () => ({ User: { findById: userFindById } }));
vi.mock("@/lib/security-mail", () => ({ notifyCredentialCreated: vi.fn() }));
// Partial: the route's own provenance gate is the real checkProvenance, and the cookie is read by
// the real reader — only the session lookup is stubbed.
vi.mock("@/lib/session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/session")>()),
  resolveSession,
}));
vi.mock("@/models/project", () => ({
  Project: {
    find: () => ({ select: () => ({ sort: () => ({ lean: async () => [] }) }) }),
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
  return res.text();
}

beforeEach(async () => {
  vi.clearAllMocks();
  await resetRateLimits();
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
    expect(await attempt("bystander")).toContain("Grant access");
  });

  it("locks out one username at a time", async () => {
    for (let i = 0; i < 11; i++) await attempt("sprayed");

    verifyCredentials.mockResolvedValue(USER);
    const body = await attempt("bystander");

    expect(body).toContain("Grant access");
  });

  it("clears the counter on a successful login", async () => {
    for (let i = 0; i < 9; i++) await attempt("recovering");

    verifyCredentials.mockResolvedValue(USER);
    expect(await attempt("recovering")).toContain("Grant access");

    verifyCredentials.mockResolvedValue(null);
    for (let i = 0; i < 9; i++) await attempt("recovering");

    verifyCredentials.mockResolvedValue(USER);
    expect(await attempt("recovering")).toContain("Grant access");
  });

  it("still issues a consent ticket for correct credentials", async () => {
    verifyCredentials.mockResolvedValue(USER);

    const body = await attempt("happy");

    expect(body).toContain("Grant access");
    expect(oauthConsentCreate).toHaveBeenCalledTimes(1);
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
    resolveSession.mockResolvedValue({ userId: "u1" });

    const body = await (await GET(authorizeGet({}, sessionCookie()))).text();

    expect(body).toContain("Grant access");
    expect(body).toContain("victim");
    expect(body).not.toContain("Sign in to");
    expect(oauthConsentCreate).toHaveBeenCalledTimes(1);
  });

  it("asks anyway when the request says prompt=login", async () => {
    resolveSession.mockResolvedValue({ userId: "u1" });

    const body = await (await GET(authorizeGet({ prompt: "login" }, sessionCookie()))).text();

    expect(body).toContain("Sign in to");
    expect(oauthConsentCreate).not.toHaveBeenCalled();
  });

  // An access token belongs to an application. Letting one stand in for the person at the keyboard
  // would let an application mint itself a second, wider credential without anybody present.
  it("does not let a bearer token stand in for the person authorizing", async () => {
    const body = await (
      await GET(authorizeGet({}, { authorization: "Bearer cpat_whatever" }))
    ).text();

    expect(body).toContain("Sign in to");
    expect(resolveSession).not.toHaveBeenCalled();
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
      redirectUri: REDIRECT_URI,
      codeChallenge: "challenge",
      state: "s",
      scope: "mcp",
      expiresAt: new Date(Date.now() + 60_000),
    });
    userFindById.mockResolvedValue(USER);
    oauthCodeCreate.mockResolvedValue({});
  });

  function consent(fields: Record<string, string>) {
    return new Request("http://localhost/oauth/authorize", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "sec-fetch-site": "same-origin",
      },
      body: new URLSearchParams({ phase: "consent", ticket: "t1", ...fields }),
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
    await POST(consent({ access: "all" }));
    expect(oauthCodeCreate.mock.calls[0][0].allowedProjects).toEqual([]);

    oauthCodeCreate.mockClear();
    const body = await (await POST(consent({}))).text();

    expect(body).toContain("Select at least one project");
    expect(oauthCodeCreate).not.toHaveBeenCalled();
  });
});
