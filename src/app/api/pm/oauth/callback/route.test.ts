import { describe, it, expect, vi, beforeEach } from "vitest";

const findOne = vi.fn();
const findOneAndDelete = vi.fn();
const getAuthUser = vi.fn();
const check = vi.fn();

vi.mock("@/lib/db", () => ({ connectDB: vi.fn() }));
vi.mock("@/models/pmOauthState", () => ({ PmOauthState: { findOne, findOneAndDelete } }));
vi.mock("@/models/project", () => ({ Project: { findById: vi.fn(), findOneAndUpdate: vi.fn() } }));
const logProjectAudit = vi.fn();
vi.mock("@/lib/projectAudit", () => ({ logProjectAudit }));
vi.mock("@/lib/auth", () => ({ getAuthUser }));
vi.mock("@/lib/session", () => ({ ProvenanceError: class ProvenanceError extends Error {} }));
vi.mock("@/lib/grants", () => ({ check }));
vi.mock("@/lib/encryption", () => ({ decryptSecret: (v: string) => v, encryptSecret: (v: string) => v }));
vi.mock("@/lib/pm/mcp-oauth", () => ({
  exchangeCode: vi.fn(),
  getPmOauthRedirectUri: () => "https://board.example.com/api/pm/oauth/callback",
}));

const { GET } = await import("./route");

const OWNER = { _id: "owner1", viaMachineCredential: false };

function request(headers: Record<string, string> = {}) {
  return new Request("https://board.example.com/api/pm/oauth/callback?state=nope", { headers });
}

beforeEach(() => {
  vi.clearAllMocks();
  findOne.mockResolvedValue(null);
  findOneAndDelete.mockResolvedValue(null);
  getAuthUser.mockResolvedValue(OWNER);
  check.mockResolvedValue(true);
});

// BP-316: this route is unauthenticated and built its redirect target from x-forwarded-host, so
// `GET /api/pm/oauth/callback?state=x` with a forged header answered a 302 to wherever the caller
// named. A relative Location cannot be moved by a header — the browser resolves it against the
// origin it actually asked.
describe("GET /api/pm/oauth/callback", () => {
  it("redirects to a relative path, not an absolute URL", async () => {
    const res = await GET(request());

    expect(res.status).toBe(302);
    const location = res.headers.get("location")!;
    expect(location).toBe("/projects?mcp_oauth=error%3Ainvalid_state");
    expect(location.startsWith("/")).toBe(true);
    expect(location).not.toMatch(/^https?:\/\//);
  });

  it("ignores a forged x-forwarded-host entirely", async () => {
    const res = await GET(
      request({ "x-forwarded-host": "evil.example", "x-forwarded-proto": "https" })
    );

    expect(res.headers.get("location")).not.toContain("evil.example");
  });

  it("keeps the project in the path when the state resolved to one", async () => {
    const pending = { project: "p1", serverName: "notion", initiatedBy: "owner1" };
    findOne.mockResolvedValue(pending);
    findOneAndDelete.mockResolvedValue(pending);

    const res = await GET(
      new Request("https://board.example.com/api/pm/oauth/callback?state=s&error=access_denied")
    );

    expect(res.headers.get("location")).toBe(
      "/projects/p1/settings?mcp_oauth=error%3Aaccess_denied"
    );
  });
});

// BP-749. `initiatedBy` was written by the start route and never read here, so anyone who
// presented a valid code+state pair completed the connection — a second signed-in user sent the
// authorization URL (consent phishing), or an attacker replaying their own authorization against
// someone else's state.
describe("GET /api/pm/oauth/callback — binding the flow to whoever started it", () => {
  const PENDING = { project: "p1", serverName: "notion", initiatedBy: "owner1" };

  function approveRequest() {
    return new Request("https://board.example.com/api/pm/oauth/callback?state=s&code=c");
  }

  // A code here means a real authorization already happened — review: leaving the state alive
  // would let it be redeemed later by the flow's real owner, attaching whichever third-party
  // identity approved it rather than the owner's own. Consumed on refusal specifically because
  // code is present; the no-code probes further down are the actual "does not consume" case.
  it("refuses a different signed-in user, and consumes the state since a real code was presented", async () => {
    findOne.mockResolvedValue(PENDING);
    getAuthUser.mockResolvedValue({ _id: "attacker9", viaMachineCredential: false });

    const res = await GET(approveRequest());

    expect(res.headers.get("location")).toBe("/projects/p1/settings?mcp_oauth=error%3Awrong_user");
    expect(findOneAndDelete).toHaveBeenCalledWith({ state: "s" });
  });

  it("refuses when nobody is signed in, and consumes the state since a real code was presented", async () => {
    findOne.mockResolvedValue(PENDING);
    getAuthUser.mockResolvedValue(null);

    const res = await GET(approveRequest());

    expect(res.headers.get("location")).toBe("/projects/p1/settings?mcp_oauth=error%3Awrong_user");
    expect(findOneAndDelete).toHaveBeenCalledWith({ state: "s" });
  });

  it("refuses a machine credential even when its user id matches", async () => {
    findOne.mockResolvedValue(PENDING);
    getAuthUser.mockResolvedValue({ _id: "owner1", viaMachineCredential: true });

    const res = await GET(approveRequest());

    expect(res.headers.get("location")).toBe("/projects/p1/settings?mcp_oauth=error%3Awrong_user");
  });

  it("does not consume the state on refusal when there is no code — nothing was authorized yet", async () => {
    findOne.mockResolvedValue(PENDING);
    getAuthUser.mockResolvedValue({ _id: "attacker9", viaMachineCredential: false });

    const res = await GET(
      new Request("https://board.example.com/api/pm/oauth/callback?state=s")
    );

    expect(res.headers.get("location")).toBe("/projects/p1/settings?mcp_oauth=error%3Awrong_user");
    expect(findOneAndDelete).not.toHaveBeenCalled();
  });

  // BP-749 review: identity alone is not enough if the grant it depended on is gone — the state's
  // TTL bounds the window, not project membership inside it.
  it("refuses when the initiator is no longer a project owner, even with the right identity", async () => {
    findOne.mockResolvedValue(PENDING);
    getAuthUser.mockResolvedValue({ _id: "owner1", viaMachineCredential: false });
    check.mockResolvedValue(false);

    const res = await GET(approveRequest());

    expect(check).toHaveBeenCalledWith({ _id: "owner1", viaMachineCredential: false }, "p1", "admin");
    expect(res.headers.get("location")).toBe("/projects/p1/settings?mcp_oauth=error%3Awrong_user");
    expect(findOneAndDelete).toHaveBeenCalledWith({ state: "s" });
  });

  it("admits the user who started the flow, and consumes the state", async () => {
    findOne.mockResolvedValue(PENDING);
    findOneAndDelete.mockResolvedValue(PENDING);
    getAuthUser.mockResolvedValue({ _id: "owner1", viaMachineCredential: false });
    const { Project } = await import("@/models/project");
    vi.mocked(Project.findById).mockReturnValue({
      select: () => ({ lean: () => Promise.resolve(null) }),
    } as never);

    const res = await GET(approveRequest());

    expect(findOneAndDelete).toHaveBeenCalledWith({ state: "s" });
    expect(res.headers.get("location")).toBe("/projects/p1/settings?mcp_oauth=error%3Aconnection_gone");
  });

  // ProvenanceError signals a session cookie presented from where session.ts's own provenance
  // check refuses it — the same refusal withAuth gives every other authenticated route (BP-749).
  it("refuses rather than throwing when the session fails its provenance check", async () => {
    findOne.mockResolvedValue(PENDING);
    const { ProvenanceError } = await import("@/lib/session");
    getAuthUser.mockRejectedValue(new ProvenanceError("origin-mismatch"));

    const res = await GET(approveRequest());

    expect(res.headers.get("location")).toBe("/projects/p1/settings?mcp_oauth=error%3Awrong_user");
    // A real code was presented, same as any other refusal here — consumed for the same reason.
    expect(findOneAndDelete).toHaveBeenCalledWith({ state: "s" });
  });

  it("does not consume the state on a provenance failure when there is no code", async () => {
    findOne.mockResolvedValue(PENDING);
    const { ProvenanceError } = await import("@/lib/session");
    getAuthUser.mockRejectedValue(new ProvenanceError("origin-mismatch"));

    const res = await GET(new Request("https://board.example.com/api/pm/oauth/callback?state=s"));

    expect(res.headers.get("location")).toBe("/projects/p1/settings?mcp_oauth=error%3Awrong_user");
    expect(findOneAndDelete).not.toHaveBeenCalled();
  });
});

// BP-782 and BP-786: the tokens were saved as the whole server list, over whatever had changed
// during the exchange, and the connection being made was recorded nowhere
describe("GET /api/pm/oauth/callback — storing the connection", () => {
  const PENDING = { project: "p1", serverName: "notion", initiatedBy: "owner1", codeVerifier: "v" };
  const server = (oauth: Record<string, unknown>) => ({
    name: "notion",
    url: "https://mcp.notion.com/mcp",
    authType: "oauth",
    oauth: { clientId: "c1", tokenEndpoint: "https://provider.example/token", ...oauth },
  });

  async function stored(oauth: Record<string, unknown>, written: unknown = "same") {
    const { Project } = await import("@/models/project");
    const project = { _id: "p1", pm: { mcpServers: [server(oauth)] } };
    vi.mocked(Project.findById).mockReturnValue({
      select: () => ({ lean: () => Promise.resolve(project) }),
    } as never);
    vi.mocked(Project.findOneAndUpdate).mockReturnValue({
      lean: () => Promise.resolve(written === "same" ? project : written),
    } as never);
    return Project;
  }

  beforeEach(async () => {
    findOne.mockResolvedValue(PENDING);
    findOneAndDelete.mockResolvedValue(PENDING);
    const { exchangeCode } = await import("@/lib/pm/mcp-oauth");
    vi.mocked(exchangeCode).mockResolvedValue({
      accessToken: "access",
      refreshToken: "refresh",
      expiresAt: null,
    } as never);
  });

  const approve = () => GET(new Request("https://board.example.com/api/pm/oauth/callback?state=s&code=c"));

  it("writes the tokens to the server and client it exchanged them for, and nothing else", async () => {
    const Project = await stored({ status: "unconfigured" });

    const res = await approve();

    expect(res.headers.get("location")).toBe("/projects/p1/settings?mcp_oauth=ok");
    expect(Project.findOneAndUpdate).toHaveBeenCalledWith(
      { _id: "p1", "pm.mcpServers": { $elemMatch: { name: "notion", "oauth.clientId": "c1" } } },
      {
        $set: {
          "pm.mcpServers.$.oauth.accessToken": "access",
          "pm.mcpServers.$.oauth.refreshToken": "refresh",
          "pm.mcpServers.$.oauth.expiresAt": null,
          "pm.mcpServers.$.oauth.status": "connected",
        },
      },
      { returnDocument: "before" }
    );
  });

  it("records the connection under the person who made it", async () => {
    await stored({ status: "unconfigured" });

    await approve();

    expect(logProjectAudit).toHaveBeenCalledWith(
      "p1",
      "owner1",
      "settings_updated",
      "PM MCP server notion · OAuth: unconfigured → connected"
    );
  });

  it("records a reconnection as one", async () => {
    await stored({ status: "connected" });

    await approve();

    expect(logProjectAudit).toHaveBeenCalledWith(
      "p1",
      "owner1",
      "settings_updated",
      "PM MCP server notion · OAuth connection renewed"
    );
  });

  it("stores nothing and records nothing when the client changed during the exchange", async () => {
    await stored({ status: "unconfigured" }, null);

    const res = await approve();

    expect(res.headers.get("location")).toBe("/projects/p1/settings?mcp_oauth=error%3Aconnection_gone");
    expect(logProjectAudit).not.toHaveBeenCalled();
  });
});
