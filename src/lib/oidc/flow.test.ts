import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createHash } from "crypto";
import type { OidcProvider } from "./providers";

const discovery = vi.fn();
const authorizationCodeGrant = vi.fn();
const buildAuthorizationUrl = vi.fn();
const findOneAndDelete = vi.fn();
const create = vi.fn();
const allowInsecureRequests = vi.fn();
const Configuration = vi.fn(function (this: Record<string, unknown>, ...args: unknown[]) {
  this.args = args;
});

vi.mock("openid-client", () => ({
  discovery,
  authorizationCodeGrant,
  buildAuthorizationUrl,
  allowInsecureRequests,
  Configuration,
  ClientSecretPost: (secret: string) => ({ post: secret }),
  skipStateCheck: Symbol("skip-state-check"),
  randomPKCECodeVerifier: () => "verifier",
  calculatePKCECodeChallenge: async () => "challenge",
  randomState: () => "state-1",
  randomNonce: () => "nonce-1",
}));
vi.mock("@/lib/db", () => ({ connectDB: vi.fn() }));
const flowFindOne = vi.fn();
const flowDeleteOne = vi.fn();
vi.mock("@/models/oidcFlow", () => ({
  OidcFlow: { findOneAndDelete, create, findOne: (...a: unknown[]) => flowFindOne(...a), deleteOne: (...a: unknown[]) => flowDeleteOne(...a) },
}));

const { beginFlow, finishFlow, holdForSignUp, heldAcceptance, heldSignUp, spendAcceptance } = await import("./flow");

const sha256 = (v: string) => createHash("sha256").update(v).digest("hex");
const PROVIDER = { id: "oidc" as const, kind: "oidc" as const, linksByAddress: true, label: "Acme", issuer: "https://id.example.com", clientId: "c", clientSecret: "s" };
const ORIGIN = "https://planner.example";

beforeEach(() => {
  vi.clearAllMocks();
  discovery.mockResolvedValue({ config: true });
  buildAuthorizationUrl.mockReturnValue(new URL("https://id.example.com/authorize?x=1"));
  create.mockResolvedValue({});
});

describe("beginning a sign-in", () => {
  it("asks for code + PKCE, with state and nonce, back to this instance's own address", async () => {
    const { url, binder } = await beginFlow({ provider: PROVIDER, origin: ORIGIN, intent: "signin" });

    expect(url).toBe("https://id.example.com/authorize?x=1");
    expect(buildAuthorizationUrl.mock.calls[0][1]).toEqual({
      redirect_uri: "https://planner.example/api/auth/oidc/oidc/callback",
      scope: "openid email profile",
      code_challenge: "challenge",
      code_challenge_method: "S256",
      state: "state-1",
      nonce: "nonce-1",
    });
    // Only the binder's hash is stored; the browser holds the binder itself
    const row = create.mock.calls[0][0];
    expect(row).toMatchObject({ binderHash: sha256(binder), state: "state-1", nonce: "nonce-1", codeVerifier: "verifier" });
    expect(JSON.stringify(row)).not.toContain(binder);
  });

  it("accepts plain http only from an issuer on this machine", async () => {
    await beginFlow({ provider: { ...PROVIDER, issuer: "http://127.0.0.1:9999" }, origin: ORIGIN, intent: "signin" });
    await beginFlow({ provider: { ...PROVIDER, issuer: "http://id.example.com" }, origin: ORIGIN, intent: "signin" });

    expect(discovery.mock.calls[0][4]).toEqual({ execute: [allowInsecureRequests] });
    expect(discovery.mock.calls[1][4]).toEqual({ execute: [] });
  });
});

describe("finishing a sign-in", () => {
  const FLOW = { provider: "oidc", state: "state-1", nonce: "nonce-1", codeVerifier: "verifier", intent: "signin", invitationTokenHash: null };

  function grantGives(claims: Record<string, unknown>) {
    authorizationCodeGrant.mockResolvedValue({ claims: () => claims });
  }

  it("refuses a callback with no binder cookie, without looking anything up", async () => {
    expect(await finishFlow({ provider: PROVIDER, binder: null, origin: ORIGIN, query: "?code=c" })).toEqual({
      ok: false,
      reason: "no_flow",
    });
    expect(findOneAndDelete).not.toHaveBeenCalled();
  });

  it("spends the flow its cookie names, once, and only while it is live", async () => {
    findOneAndDelete.mockResolvedValue(null);

    const outcome = await finishFlow({ provider: PROVIDER, binder: "cpo_b", origin: ORIGIN, query: "?code=c" });

    expect(outcome).toEqual({ ok: false, reason: "no_flow" });
    expect(findOneAndDelete.mock.calls[0][0]).toEqual({
      binderHash: sha256("cpo_b"),
      provider: "oidc",
      expiresAt: { $gt: expect.any(Date) },
      claims: null,
    });
  });

  it("has the library check the code against the state, nonce and verifier it issued", async () => {
    findOneAndDelete.mockResolvedValue(FLOW);
    grantGives({ iss: "https://id.example.com", sub: "s1", email: "Ada@Example.com", email_verified: true, name: "Ada" });

    const outcome = await finishFlow({ provider: PROVIDER, binder: "cpo_b", origin: ORIGIN, query: "?code=c&state=state-1" });

    expect(authorizationCodeGrant.mock.calls[0][1].href).toBe(
      "https://planner.example/api/auth/oidc/oidc/callback?code=c&state=state-1"
    );
    expect(authorizationCodeGrant.mock.calls[0][2]).toEqual({
      pkceCodeVerifier: "verifier",
      expectedState: "state-1",
      expectedNonce: "nonce-1",
      idTokenExpected: true,
    });
    expect(outcome).toEqual({
      ok: true,
      intent: "signin",
      invitationTokenHash: null,
      userId: null,
      next: null,
      bootstrap: null,
      claims: {
        issuer: "https://id.example.com",
        subject: "s1",
        email: "ada@example.com",
        emailVerified: true,
        verifiedEmails: ["ada@example.com"],
        name: "Ada",
        groups: [],
      },
    });
  });

  it.each([[undefined], ["true"], [1]])("treats email_verified %j as not verified", async (value) => {
    findOneAndDelete.mockResolvedValue(FLOW);
    grantGives({ iss: "https://id.example.com", sub: "s1", email: "ada@example.com", email_verified: value });

    const outcome = await finishFlow({ provider: PROVIDER, binder: "cpo_b", origin: ORIGIN, query: "" });

    expect(outcome.ok && outcome.claims.emailVerified).toBe(false);
    expect(outcome.ok && outcome.claims.verifiedEmails).toEqual([]);
  });

  it("refuses whatever the library refuses", async () => {
    findOneAndDelete.mockResolvedValue(FLOW);
    authorizationCodeGrant.mockRejectedValue(new Error("state mismatch"));

    expect(await finishFlow({ provider: PROVIDER, binder: "cpo_b", origin: ORIGIN, query: "" })).toEqual({
      ok: false,
      reason: "rejected",
    });
  });
});

describe("what Google vouches for", () => {
  const GOOGLE = { ...PROVIDER, id: "google" as const, issuer: "https://accounts.google.com" };
  const FLOW = { provider: "google", state: "state-1", nonce: "nonce-1", codeVerifier: "verifier", intent: "signin", invitationTokenHash: null };

  // A consumer Google account can be opened on any address; Google only speaks for its own
  // domain and for the ones a Workspace manages
  it.each([
    ["a gmail.com address", { email: "ada@gmail.com" }, true],
    ["a googlemail.com address", { email: "ada@googlemail.com" }, true],
    ["a Workspace address", { email: "ada@corp.com", hd: "corp.com" }, true],
    ["a company address on a consumer account", { email: "ada@corp.com" }, false],
    // BP-845
    ["a lookalike of gmail.com", { email: "ada@notgmail.com" }, false],
    ["an empty Workspace domain", { email: "ada@corp.com", hd: "" }, false],
  ])("counts %s as verified: %s", async (_label, claims, verified) => {
    findOneAndDelete.mockResolvedValue(FLOW);
    authorizationCodeGrant.mockResolvedValue({
      claims: () => ({ iss: "https://accounts.google.com", sub: "g1", email_verified: true, ...claims }),
    });

    const outcome = await finishFlow({ provider: GOOGLE, binder: "cpo_b", origin: ORIGIN, query: "" });

    expect(outcome.ok && outcome.claims.emailVerified).toBe(verified);
  });

  it("leaves a generic issuer's word on verification alone", async () => {
    findOneAndDelete.mockResolvedValue({ ...FLOW, provider: "oidc" });
    authorizationCodeGrant.mockResolvedValue({
      claims: () => ({ iss: "https://id.example.com", sub: "s1", email: "ada@corp.com", email_verified: true }),
    });

    const outcome = await finishFlow({ provider: PROVIDER, binder: "cpo_b", origin: ORIGIN, query: "" });

    expect(outcome.ok && outcome.claims.emailVerified).toBe(true);
  });
});

describe("GitHub, which speaks OAuth 2 without OpenID Connect", () => {
  const GITHUB = {
    id: "github" as const,
    kind: "github" as const,
    linksByAddress: false,
    label: "GitHub",
    issuer: "https://github.com",
    clientId: "gh",
    clientSecret: "gh-secret",
  };
  const FLOW = { provider: "github", state: "state-1", nonce: "-", codeVerifier: "verifier", intent: "signin", invitationTokenHash: null };
  const fetchMock = vi.fn();

  function githubAnswers(person: unknown, emails: unknown, status = 200) {
    fetchMock.mockImplementation(async (url: string) => {
      const body = url.endsWith("/user/emails") ? emails : person;
      return new Response(JSON.stringify(body), { status });
    });
  }

  beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock);
    delete process.env.GITHUB_API_BASE_URL;
    findOneAndDelete.mockResolvedValue(FLOW);
    authorizationCodeGrant.mockResolvedValue({ access_token: "gho_token" });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("asks GitHub's own endpoints for a code, with PKCE and state but no nonce", async () => {
    await beginFlow({ provider: GITHUB, origin: ORIGIN, intent: "signin" });

    expect(discovery).not.toHaveBeenCalled();
    expect(Configuration.mock.calls[0]).toEqual([
      {
        issuer: "https://github.com",
        authorization_endpoint: "https://github.com/login/oauth/authorize",
        token_endpoint: "https://github.com/login/oauth/access_token",
      },
      "gh",
      undefined,
      { post: "gh-secret" },
    ]);
    expect(buildAuthorizationUrl.mock.calls[0][1]).toEqual({
      redirect_uri: "https://planner.example/api/auth/oidc/github/callback",
      scope: "user:email",
      code_challenge: "challenge",
      code_challenge_method: "S256",
      state: "state-1",
    });
  });

  it("accepts plain http only from a GitHub on this machine", async () => {
    await beginFlow({ provider: { ...GITHUB, issuer: "http://127.0.0.1:9999" }, origin: ORIGIN, intent: "signin" });
    expect(allowInsecureRequests).toHaveBeenCalledTimes(1);

    await beginFlow({ provider: { ...GITHUB, issuer: "http://ghe.example.com" }, origin: ORIGIN, intent: "signin" });
    expect(allowInsecureRequests).toHaveBeenCalledTimes(1);
  });

  it("checks the code against state and verifier, then reads the person from the API", async () => {
    process.env.GITHUB_API_BASE_URL = "https://ghe.example.com/api/v3";
    githubAnswers({ id: 4242, login: "ada", name: "Ada Lovelace" }, [
      { email: "ada@personal.example", primary: false, verified: true },
      { email: "Ada@Corp.example", primary: true, verified: true },
    ]);

    const outcome = await finishFlow({ provider: { ...GITHUB, issuer: "https://ghe.example.com" }, binder: "cpo_b", origin: ORIGIN, query: "?code=c&state=state-1" });

    expect(authorizationCodeGrant.mock.calls[0][2]).toEqual({ pkceCodeVerifier: "verifier", expectedState: "state-1" });
    expect(fetchMock.mock.calls.map(([url]) => url).sort()).toEqual([
      "https://ghe.example.com/api/v3/user",
      "https://ghe.example.com/api/v3/user/emails",
    ]);
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe("Bearer gho_token");
    expect(outcome).toEqual({
      ok: true,
      intent: "signin",
      invitationTokenHash: null,
      userId: null,
      next: null,
      bootstrap: null,
      claims: {
        issuer: "https://ghe.example.com",
        subject: "4242",
        email: "ada@corp.example",
        emailVerified: true,
        verifiedEmails: ["ada@personal.example", "ada@corp.example"],
        name: "Ada Lovelace",
        groups: [],
      },
    });
  });

  it.each([
    [
      "another verified address when the primary is not",
      [
        { email: "ada@corp.example", primary: true, verified: false },
        { email: "ada@personal.example", primary: false, verified: true },
      ],
      "ada@personal.example",
      true,
    ],
    ["the primary as unverified when none is verified", [{ email: "ada@corp.example", primary: true, verified: false }], "ada@corp.example", false],
    ["no address at all when GitHub lists none", [], "", false],
  ])("takes %s", async (_label, emails, email, emailVerified) => {
    githubAnswers({ id: 4242, login: "ada" }, emails);

    const outcome = await finishFlow({ provider: GITHUB, binder: "cpo_b", origin: ORIGIN, query: "" });

    expect(outcome.ok && outcome.claims).toMatchObject({ email, emailVerified, name: "ada" });
  });

  it("vouches for no address GitHub has not verified", async () => {
    githubAnswers({ id: 4242, login: "ada" }, [
      { email: "ada@corp.example", primary: true, verified: false },
      { email: "ada@old.example", primary: false, verified: "true" },
    ]);

    const outcome = await finishFlow({ provider: GITHUB, binder: "cpo_b", origin: ORIGIN, query: "" });

    expect(outcome.ok && outcome.claims.verifiedEmails).toEqual([]);
    expect(outcome.ok && outcome.claims).toMatchObject({ email: "ada@corp.example", emailVerified: false });
  });

  it.each([
    ["github.com", "https://github.com", "https://api.github.com/user"],
    ["a data-residency tenant", "https://acme.ghe.com", "https://api.acme.ghe.com/user"],
    ["an Enterprise Server", "https://ghe.example.com", "https://ghe.example.com/api/v3/user"],
  ])("reads the person from %s's own API when no API base is set", async (_label, site, expected) => {
    githubAnswers({ id: 1, login: "ada" }, []);

    await finishFlow({ provider: { ...GITHUB, issuer: site }, binder: "cpo_b", origin: ORIGIN, query: "" });

    expect(fetchMock.mock.calls.map(([url]) => url)).toContain(expected);
  });

  it.each([
    ["github.com's API, for an Enterprise Server", "https://api.github.com", "https://ghe.example.com", "https://ghe.example.com/api/v3/user"],
    ["another Enterprise Server's API", "https://other.example.com/api/v3", "https://ghe.example.com", "https://ghe.example.com/api/v3/user"],
    ["a proxy", "https://gh-proxy.corp", "https://ghe.example.com", "https://gh-proxy.corp/user"],
    ["this site's own API", "https://ghe.example.com/api/v3", "https://ghe.example.com", "https://ghe.example.com/api/v3/user"],
  ])("given GITHUB_API_BASE_URL naming %s, sends the token only to this site's", async (_l, api, site, expected) => {
    process.env.GITHUB_API_BASE_URL = api;
    githubAnswers({ id: 1, login: "ada" }, []);

    await finishFlow({ provider: { ...GITHUB, issuer: site }, binder: "cpo_b", origin: ORIGIN, query: "" });

    expect(fetchMock.mock.calls.map(([url]) => url).sort()).toEqual([expected, `${expected}/emails`]);
  });

  it("refuses when GitHub will not say who it is", async () => {
    githubAnswers({ message: "Bad credentials" }, [], 401);

    expect(await finishFlow({ provider: GITHUB, binder: "cpo_b", origin: ORIGIN, query: "" })).toEqual({
      ok: false,
      reason: "rejected",
    });
  });

  it("refuses when GitHub names the person but will not list their addresses", async () => {
    fetchMock.mockImplementation(async (url: string) =>
      url.endsWith("/user/emails")
        ? new Response(JSON.stringify({ message: "Server Error" }), { status: 500 })
        : new Response(JSON.stringify({ id: 4242, login: "ada" }), { status: 200 })
    );

    expect((await finishFlow({ provider: GITHUB, binder: "cpo_b", origin: ORIGIN, query: "" })).ok).toBe(false);
  });

  it("refuses a person with no id", async () => {
    githubAnswers({ login: "ada" }, [{ email: "ada@corp.example", primary: true, verified: true }]);

    expect((await finishFlow({ provider: GITHUB, binder: "cpo_b", origin: ORIGIN, query: "" })).ok).toBe(false);
  });
});

describe("the groups an ID token names (BP-833)", () => {
  const FLOW = { provider: "oidc", state: "state-1", nonce: "nonce-1", codeVerifier: "verifier", intent: "signin", invitationTokenHash: null };
  const finishWith = async (provider: OidcProvider, claims: Record<string, unknown>) => {
    findOneAndDelete.mockResolvedValue({ ...FLOW, provider: provider.id });
    authorizationCodeGrant.mockResolvedValue({
      claims: () => ({ iss: provider.issuer, sub: "s1", email: "ada@corp.com", email_verified: true, hd: "corp.com", ...claims }),
    });
    const outcome = await finishFlow({ provider, binder: "cpo_b", origin: ORIGIN, query: "" });
    return outcome.ok ? outcome.claims.groups : null;
  };

  afterEach(() => {
    delete process.env.OIDC_GROUPS_CLAIM;
  });

  it("reads them from the groups claim, a list or a single name", async () => {
    expect(await finishWith(PROVIDER, { groups: ["staff", "admins", 7] })).toEqual(["staff", "admins"]);
    expect(await finishWith(PROVIDER, { groups: "admins" })).toEqual(["admins"]);
    expect(await finishWith(PROVIDER, {})).toEqual([]);
  });

  it("reads the claim OIDC_GROUPS_CLAIM names instead", async () => {
    process.env.OIDC_GROUPS_CLAIM = "roles";

    expect(await finishWith(PROVIDER, { groups: ["admins"], roles: ["planner-admins"] })).toEqual(["planner-admins"]);
  });

  it("warns once, with the admin group set, when the token carries no groups claim", async () => {
    process.env.OIDC_ADMIN_GROUP = "admins";
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await finishWith(PROVIDER, {});
      await finishWith(PROVIDER, {});
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0][0]).toContain('no "groups" claim');
    } finally {
      warn.mockRestore();
      delete process.env.OIDC_ADMIN_GROUP;
    }
  });

  it("takes none from Google, whatever its token carries", async () => {
    const GOOGLE = { ...PROVIDER, id: "google" as const, issuer: "https://accounts.google.com" };

    expect(await finishWith(GOOGLE, { groups: ["admins"] })).toEqual([]);
  });

  it("holds a sign-up with the name and groups it will be made with", async () => {
    const binder = await holdForSignUp({
      provider: PROVIDER,
      claims: { issuer: "https://id.example.com", subject: "s1", email: "ada@corp.com", emailVerified: true, verifiedEmails: ["ada@corp.com"], name: "Ada", groups: ["admins"] },
    });

    expect(create.mock.calls[0][0]).toMatchObject({
      binderHash: sha256(binder),
      intent: "signup",
      claims: { issuer: "https://id.example.com", subject: "s1", email: "ada@corp.com", name: "Ada", groups: ["admins"] },
    });
  });
});

// BP-845. Each read is bound to its own intent and to a live row, and spending one ends it
describe("the verified sign-ins held for a form", () => {
  beforeEach(() => {
    flowFindOne.mockReturnValue({ lean: async () => ({ claims: { email: "ada@corp.com" } }) });
    flowDeleteOne.mockResolvedValue({});
  });

  it("reads an invitation's hold by its binder, its intent, held claims and a live expiry", async () => {
    await heldAcceptance("cpo_held");

    expect(flowFindOne).toHaveBeenCalledWith({
      binderHash: sha256("cpo_held"),
      intent: "invite",
      claims: { $ne: null },
      expiresAt: { $gt: expect.any(Date) },
    });
  });

  it("reads a sign-up's hold only as a sign-up", async () => {
    await heldSignUp("cpo_join");

    expect(flowFindOne).toHaveBeenCalledWith({
      binderHash: sha256("cpo_join"),
      intent: "signup",
      claims: { $ne: null },
      expiresAt: { $gt: expect.any(Date) },
    });
  });

  it("reads nothing at all without a binder", async () => {
    expect(await heldAcceptance(null)).toBeNull();
    expect(await heldSignUp(null)).toBeNull();
    expect(flowFindOne).not.toHaveBeenCalled();
  });

  it("spends a hold by deleting it, and only a held one", async () => {
    await spendAcceptance("cpo_held");

    expect(flowDeleteOne).toHaveBeenCalledWith({ binderHash: sha256("cpo_held"), claims: { $ne: null } });
  });
});
