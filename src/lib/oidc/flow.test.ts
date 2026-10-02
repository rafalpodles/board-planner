import { describe, it, expect, vi, beforeEach } from "vitest";
import { createHash } from "crypto";

const discovery = vi.fn();
const authorizationCodeGrant = vi.fn();
const buildAuthorizationUrl = vi.fn();
const findOneAndDelete = vi.fn();
const create = vi.fn();

vi.mock("openid-client", () => ({
  discovery,
  authorizationCodeGrant,
  buildAuthorizationUrl,
  allowInsecureRequests: "allow-insecure",
  skipStateCheck: Symbol("skip-state-check"),
  randomPKCECodeVerifier: () => "verifier",
  calculatePKCECodeChallenge: async () => "challenge",
  randomState: () => "state-1",
  randomNonce: () => "nonce-1",
}));
vi.mock("@/lib/db", () => ({ connectDB: vi.fn() }));
vi.mock("@/models/oidcFlow", () => ({ OidcFlow: { findOneAndDelete, create, findOne: vi.fn(), deleteOne: vi.fn() } }));

const { beginFlow, finishFlow } = await import("./flow");

const sha256 = (v: string) => createHash("sha256").update(v).digest("hex");
const PROVIDER = { id: "oidc" as const, label: "Acme", issuer: "https://id.example.com", clientId: "c", clientSecret: "s" };
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

    expect(discovery.mock.calls[0][4]).toEqual({ execute: ["allow-insecure"] });
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
      claims: { issuer: "https://id.example.com", subject: "s1", email: "ada@example.com", emailVerified: true, name: "Ada" },
    });
  });

  it.each([[undefined], ["true"], [1]])("treats email_verified %j as not verified", async (value) => {
    findOneAndDelete.mockResolvedValue(FLOW);
    grantGives({ iss: "https://id.example.com", sub: "s1", email: "ada@example.com", email_verified: value });

    const outcome = await finishFlow({ provider: PROVIDER, binder: "cpo_b", origin: ORIGIN, query: "" });

    expect(outcome.ok && outcome.claims.emailVerified).toBe(false);
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
    ["a Workspace address", { email: "ada@corp.com", hd: "corp.com" }, true],
    ["a company address on a consumer account", { email: "ada@corp.com" }, false],
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
