import { describe, it, expect, vi, beforeEach } from "vitest";

const verifyCredentials = vi.fn();
const oauthClientFindOne = vi.fn();
const oauthConsentCreate = vi.fn();

vi.mock("@/lib/db", () => ({ connectDB: vi.fn() }));
vi.mock("@/models/rateLimit", async () => {
  const { inMemoryRateLimitModel } = await import("@/lib/rate-limit-test-store");
  return { RateLimit: inMemoryRateLimitModel() };
});

vi.mock("@/lib/auth", () => ({ verifyCredentials, getClientIp: () => "203.0.113.7" }));
vi.mock("@/lib/grants", () => ({ accessibleProjectIds: vi.fn().mockResolvedValue(null) }));
vi.mock("@/models/oauthClient", () => ({ OAuthClient: { findOne: oauthClientFindOne } }));
vi.mock("@/models/oauthCode", () => ({ OAuthCode: { create: vi.fn() } }));
vi.mock("@/models/oauthConsent", () => ({
  OAuthConsent: { create: oauthConsentCreate, findOne: vi.fn(), deleteOne: vi.fn() },
}));
vi.mock("@/models/user", () => ({ User: { findById: vi.fn() } }));
vi.mock("@/models/project", () => ({
  Project: {
    find: () => ({ select: () => ({ sort: () => ({ lean: async () => [] }) }) }),
  },
}));

const { POST } = await import("./route");
const { resetRateLimits, ANONYMOUS_ACCOUNT_ATTEMPTS } = await import("@/lib/rate-limit");

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
    headers: { "content-type": "application/x-www-form-urlencoded" },
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
    // The threshold is raised rather than removed: aiming it costs five times what it did.
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
});
