import { describe, it, expect, vi, beforeEach } from "vitest";

const getAuthUser = vi.fn();
const check = vi.fn();
const projectFindById = vi.fn();
const pmOauthStateCreate = vi.fn();
const discoverOauthConfig = vi.fn();
const registerClient = vi.fn();

vi.mock("@/lib/db", () => ({ connectDB: vi.fn() }));
vi.mock("@/lib/auth", () => ({
  getAuthUser,
  RateLimitError: class RateLimitError extends Error {},
}));
vi.mock("@/lib/grants", () => ({ check }));
vi.mock("@/models/project", () => ({
  Project: { findById: projectFindById },
}));
vi.mock("@/models/pmOauthState", () => ({ PmOauthState: { create: pmOauthStateCreate } }));
vi.mock("@/lib/encryption", () => ({ encryptSecret: (v: string) => `enc:${v}` }));
vi.mock("@/lib/session", () => ({
  selfOrigin: () => "https://board.example.com",
  ORIGIN_REQUIRED: "origin required",
}));
vi.mock("@/lib/pm/mcp-oauth", () => ({
  discoverOauthConfig,
  registerClient,
  createPkce: () => ({ verifier: "v", challenge: "c" }),
  buildAuthorizationUrl: () => "https://provider.example/authorize?x=1",
  getPmOauthRedirectUri: () => "https://board.example.com/api/pm/oauth/callback",
}));

const { POST } = await import("./route");

const OWNER = { _id: "u1", role: "member" };
const MEMBER = { _id: "u2", role: "member" };
const PROJECT_ID = "507f1f77bcf86cd799439011";
const REDIRECT_URI = "https://board.example.com/api/pm/oauth/callback";

function request(body: unknown = { name: "srv" }) {
  return new Request("http://localhost/api/projects/p1/pm/mcp-oauth/start", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const ctx = () => ({ params: Promise.resolve({ projectId: PROJECT_ID }) });

function projectWithServer(oauth: Record<string, unknown>) {
  const server = {
    name: "srv",
    authType: "oauth",
    url: "https://mcp.example/mcp",
    oauth,
  };
  return {
    pm: { mcpServers: [server] },
    markModified: vi.fn(),
    save: vi.fn().mockResolvedValue(undefined),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  getAuthUser.mockResolvedValue(OWNER);
  check.mockResolvedValue(true);
  projectFindById.mockResolvedValue(null);
  discoverOauthConfig.mockResolvedValue({
    authorizationEndpoint: "https://provider.example/authorize",
    tokenEndpoint: "https://provider.example/token",
    registrationEndpoint: "https://provider.example/register",
    scopes: [],
    tokenAuthMethod: "none",
  });
  registerClient.mockResolvedValue({ clientId: "fresh-registered-id", clientSecret: "" });
});

// The callback this flow ends in trusts only the single-use state row and never re-checks
// who completes it — so anyone who reaches this route gets a real authorizationUrl and can
// rewire the project's stored OAuth connection to their own external account.
describe("POST /api/projects/[projectId]/pm/mcp-oauth/start", () => {
  it("admits a project owner past the guard", async () => {
    check.mockResolvedValue(true);

    const response = await POST(request(), ctx());

    expect(response.status).toBe(404);
    expect(projectFindById).toHaveBeenCalledWith(PROJECT_ID);
    expect(check).toHaveBeenCalledWith(expect.anything(), PROJECT_ID, "admin");
  });

  it("denies a plain member", async () => {
    check.mockResolvedValue(false);
    getAuthUser.mockResolvedValue(MEMBER);

    const response = await POST(request(), ctx());

    expect(response.status).toBe(403);
    expect(projectFindById).not.toHaveBeenCalled();
  });
});

// BP-751. A dynamically registered client is bound to the callback it registered with, so the
// app re-registering it when that address changes is correct — but a client the admin typed by
// hand is registered with the provider by the admin, not by this app, and this app re-registering
// it anyway silently hands the connection a client_id the provider has never heard of.
describe("POST /api/projects/[projectId]/pm/mcp-oauth/start — a client whose callback changed", () => {
  it("re-registers silently when the stored client is this app's own registration", async () => {
    projectFindById.mockResolvedValue(
      projectWithServer({
        clientId: "old-registered-id",
        clientSecret: "enc:old-secret",
        clientSource: "registered",
        authorizationEndpoint: "https://provider.example/authorize",
        tokenEndpoint: "https://provider.example/token",
        registrationEndpoint: "https://provider.example/register",
        redirectUri: "https://old.example.com/api/pm/oauth/callback",
        accessToken: "enc:stale-access",
        refreshToken: "enc:stale-refresh",
        expiresAt: new Date(Date.now() + 3600_000),
        status: "connected",
      })
    );

    const res = await POST(request(), ctx());

    expect(res.status).toBe(200);
    expect(registerClient).toHaveBeenCalledWith("https://provider.example/register", REDIRECT_URI);
    // The route mutates the object `findById` resolved to in place, then saves it.
    const oauth = (await projectFindById.mock.results[0].value).pm.mcpServers[0].oauth;
    expect(oauth).toMatchObject({
      clientId: "fresh-registered-id",
      clientSource: "registered",
      status: "unconfigured",
      accessToken: "",
      refreshToken: "",
      expiresAt: null,
    });
  });

  it("refuses rather than replacing a client the admin typed by hand", async () => {
    projectFindById.mockResolvedValue(
      projectWithServer({
        clientId: "admin-typed-id",
        clientSecret: "enc:admin-secret",
        clientSource: "typed",
        authorizationEndpoint: "https://provider.example/authorize",
        tokenEndpoint: "https://provider.example/token",
        redirectUri: "https://old.example.com/api/pm/oauth/callback",
        status: "connected",
      })
    );

    const res = await POST(request(), ctx());

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: expect.stringContaining(REDIRECT_URI) });
    expect(registerClient).not.toHaveBeenCalled();
    expect(pmOauthStateCreate).not.toHaveBeenCalled();
    const oauth = (await projectFindById.mock.results[0].value).pm.mcpServers[0].oauth;
    expect(oauth.clientId).toBe("admin-typed-id");
    expect(oauth.clientSecret).toBe("enc:admin-secret");
  });

  it("refuses a legacy record with unknown provenance the same way, rather than guessing", async () => {
    projectFindById.mockResolvedValue(
      projectWithServer({
        clientId: "legacy-id",
        clientSecret: "enc:legacy-secret",
        // A connection that genuinely worked before `redirectUri` was tracked: discovery has
        // completed (authorizationEndpoint is set) but no clientSource, no stored redirectUri —
        // every record from before both fields existed. Distinct from a server that has simply
        // never connected, which has no authorizationEndpoint either.
        authorizationEndpoint: "https://provider.example/authorize",
        tokenEndpoint: "https://provider.example/token",
        status: "connected",
      })
    );

    const res = await POST(request(), ctx());

    expect(res.status).toBe(400);
    expect(registerClient).not.toHaveBeenCalled();
    const oauth = (await projectFindById.mock.results[0].value).pm.mcpServers[0].oauth;
    expect(oauth.clientId).toBe("legacy-id");
  });

  it("does nothing special when the callback address has not changed", async () => {
    projectFindById.mockResolvedValue(
      projectWithServer({
        clientId: "admin-typed-id",
        clientSecret: "enc:admin-secret",
        clientSource: "typed",
        redirectUri: REDIRECT_URI,
        authorizationEndpoint: "https://provider.example/authorize",
        tokenEndpoint: "https://provider.example/token",
        status: "connected",
      })
    );

    const res = await POST(request(), ctx());

    expect(res.status).toBe(200);
    expect(registerClient).not.toHaveBeenCalled();
    const oauth = (await projectFindById.mock.results[0].value).pm.mcpServers[0].oauth;
    expect(oauth.clientId).toBe("admin-typed-id");
  });

  // The control this whole describe block needs: a server whose Connect has never once
  // succeeded also has an empty `redirectUri` and no `authorizationEndpoint` — for the ordinary
  // reason that this route has never finished a run for it, not because a callback changed. That
  // must not be mistaken for the "changed since a real connection" case above.
  it("connects normally on the very first attempt, although redirectUri has never been set", async () => {
    projectFindById.mockResolvedValue(
      projectWithServer({ clientId: "typed-before-ever-connecting", clientSecret: "enc:s", clientSource: "typed" })
    );

    const res = await POST(request(), ctx());

    expect(res.status).toBe(200);
    expect(registerClient).not.toHaveBeenCalled();
    const oauth = (await projectFindById.mock.results[0].value).pm.mcpServers[0].oauth;
    expect(oauth).toMatchObject({ clientId: "typed-before-ever-connecting", redirectUri: REDIRECT_URI });
  });

  it("marks a freshly registered client as this app's own", async () => {
    projectFindById.mockResolvedValue(projectWithServer({}));

    const res = await POST(request(), ctx());

    expect(res.status).toBe(200);
    const oauth = (await projectFindById.mock.results[0].value).pm.mcpServers[0].oauth;
    expect(oauth).toMatchObject({ clientId: "fresh-registered-id", clientSource: "registered" });
  });

  // Test-quality review: the leading `oauth.clientId &&` had no fixture pairing an empty
  // clientId with a set authorizationEndpoint and a stale redirectUri — a real, if unusual, shape
  // (a client disconnected and cleared by hand, on a server that had already discovered once).
  // Nothing to reset or refuse when there is no clientId; this just registers a fresh one.
  it("registers fresh rather than refusing when the client id is empty but discovery already ran", async () => {
    projectFindById.mockResolvedValue(
      projectWithServer({
        clientId: "",
        authorizationEndpoint: "https://provider.example/authorize",
        tokenEndpoint: "https://provider.example/token",
        registrationEndpoint: "https://provider.example/register",
        redirectUri: "https://old.example.com/api/pm/oauth/callback",
        status: "unconfigured",
      })
    );

    const res = await POST(request(), ctx());

    expect(res.status).toBe(200);
    expect(registerClient).toHaveBeenCalledWith("https://provider.example/register", REDIRECT_URI);
    const oauth = (await projectFindById.mock.results[0].value).pm.mcpServers[0].oauth;
    expect(oauth).toMatchObject({ clientId: "fresh-registered-id", clientSource: "registered" });
  });
});
