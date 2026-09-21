import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import sift from "sift";

const McpClientMock = vi.fn();
const updateOne = vi.fn();
const refreshTokens = vi.fn();

vi.mock("@/models/project", () => ({ Project: { updateOne } }));
// As lenient as the real one: an absent value comes back absent rather than throwing, or a test of
// the missing-refresh-token guard passes because this double threw first (BP-476 review)
vi.mock("@/lib/encryption", () => ({
  decryptSecret: (v: unknown) => (typeof v === "string" ? v.replace(/^enc:/, "") : v),
  encryptSecret: (v: string) => `enc:${v}`,
}));
vi.mock("./mcp-oauth", () => ({ refreshTokens }));
vi.mock("./config", () => ({ resolveMcpAuthToken: vi.fn(async () => "bearer-token") }));
class McpHttpError extends Error {
  constructor(public readonly status: number) {
    super(`MCP server responded ${status}`);
  }
}
vi.mock("./mcp-client", () => ({ McpClient: McpClientMock, McpHttpError }));

const { discoverMcpTools, callMcpTool } = await import("./mcp-tools");

type Tool = { name: string; description?: string; annotations?: { readOnlyHint?: boolean } };

function serving(tools: Tool[]) {
  McpClientMock.mockImplementation(() => ({
    initialize: vi.fn().mockResolvedValue(undefined),
    listTools: vi.fn().mockResolvedValue(tools),
  }));
}

const server = (over: Record<string, unknown> = {}) =>
  ({
    name: "acme",
    url: "https://acme.example/mcp",
    authType: "bearer",
    enabled: true,
    allowWrites: false,
    toolAllowlist: [],
    ...over,
  }) as never;

const hour = 60 * 60 * 1000;
const oauthServer = (oauth: Record<string, unknown>) =>
  server({
    authType: "oauth",
    oauth: {
      accessToken: "enc:old-access",
      refreshToken: "enc:the-refresh",
      expiresAt: new Date(Date.now() - hour),
      status: "connected",
      tokenEndpoint: "https://auth.example/token",
      clientId: "client-1",
      tokenAuthMethod: "none",
      ...oauth,
    },
  });

let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  vi.clearAllMocks();
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  serving([{ name: "list_tickets" }, { name: "create_ticket" }]);
});
afterEach(() => warn.mockRestore());

// BP-476: which third-party tools reach the PM agent, and on whose credentials
describe("discoverMcpTools — the gate", () => {
  it("asks nothing of a server that is switched off", async () => {
    const runtime = await discoverMcpTools("p1", [server({ enabled: false })]);

    expect(McpClientMock).not.toHaveBeenCalled();
    expect(runtime.tools.size).toBe(0);
    expect(runtime.serverNames).toEqual([]);
  });

  it("withholds a write tool while writes are off, even when the allowlist names it", async () => {
    const runtime = await discoverMcpTools("p1", [server({ toolAllowlist: ["list_tickets", "create_ticket"] })]);

    expect([...runtime.tools.keys()]).toEqual(["mcp_acme_list_tickets"]);
    expect(runtime.tools.get("mcp_acme_list_tickets")!.write).toBe(false);
  });

  // The server's own name is what lets `acme-search` read as a search, so it has to be handed over
  it("judges a tool named after its server by what follows the name", async () => {
    serving([{ name: "acme-search" }]);

    const runtime = await discoverMcpTools("p1", [server()]);

    expect(runtime.tools.get("mcp_acme_acme-search")?.write).toBe(false);
  });

  it("exposes the write tool once writes are on, marked as a write", async () => {
    const runtime = await discoverMcpTools("p1", [server({ allowWrites: true })]);

    expect(runtime.tools.get("mcp_acme_create_ticket")!.write).toBe(true);
    expect(runtime.tools.get("mcp_acme_list_tickets")!.write).toBe(false);
  });

  it("treats a read-named tool its server marks readOnlyHint: false as a write", async () => {
    serving([{ name: "list_tickets", annotations: { readOnlyHint: false } }]);

    expect((await discoverMcpTools("p1", [server()])).tools.size).toBe(0);
    const writable = await discoverMcpTools("p1", [server({ allowWrites: true })]);
    expect(writable.tools.get("mcp_acme_list_tickets")!.write).toBe(true);
  });

  it("clamps an exposed name to 64 characters and keeps a clamped collision distinct", async () => {
    const long = `list_${"x".repeat(80)}`;
    serving([{ name: `${long}_a` }, { name: `${long}_b` }]);

    const names = [...(await discoverMcpTools("p1", [server()])).tools.keys()];

    expect(names).toHaveLength(2);
    for (const name of names) expect(name.length).toBeLessThanOrEqual(64);
    expect(names[1]).toMatch(/_2$/);
  });
});

describe("discoverMcpTools — an OAuth server's token", () => {
  it("skips a server that needs re-authorisation without calling it", async () => {
    const runtime = await discoverMcpTools("p1", [oauthServer({ status: "needs_reauth" })]);

    expect(McpClientMock).not.toHaveBeenCalled();
    expect(refreshTokens).not.toHaveBeenCalled();
    expect(runtime.serverNames).toEqual([]);
  });

  it("uses a token that has not expired as it is", async () => {
    await discoverMcpTools("p1", [oauthServer({ expiresAt: new Date(Date.now() + hour) })]);

    expect(McpClientMock).toHaveBeenCalledWith("https://acme.example/mcp", "old-access");
    expect(refreshTokens).not.toHaveBeenCalled();
  });

  it("refreshes an expired token, stores the new one encrypted, and uses it", async () => {
    const expiresAt = new Date(Date.now() + hour);
    refreshTokens.mockResolvedValue({ accessToken: "new-access", refreshToken: "new-refresh", expiresAt });

    await discoverMcpTools("p1", [oauthServer({})]);

    expect(refreshTokens).toHaveBeenCalledWith(expect.objectContaining({ refreshToken: "the-refresh", resource: "https://acme.example/mcp" }));
    const [filter, update] = updateOne.mock.calls[0];
    expect(filter).toEqual({ _id: "p1", "pm.mcpServers": { $elemMatch: { name: "acme", "oauth.clientId": "client-1" } } });
    // The expiry too: without it every later turn would refresh again
    expect(update.$set).toEqual({
      "pm.mcpServers.$.oauth.accessToken": "enc:new-access",
      "pm.mcpServers.$.oauth.refreshToken": "enc:new-refresh",
      "pm.mcpServers.$.oauth.expiresAt": expiresAt,
      "pm.mcpServers.$.oauth.status": "connected",
    });
    expect(McpClientMock).toHaveBeenCalledWith("https://acme.example/mcp", "new-access");
  });

  // BP-707 review: a refresh that outlives a client id change must not write the old client's tokens
  it("writes nothing over a server whose client id changed while the refresh was in flight", async () => {
    refreshTokens.mockResolvedValue({ accessToken: "new-access", expiresAt: new Date(Date.now() + hour) });

    await discoverMcpTools("p1", [oauthServer({})]);

    const [filter] = updateOne.mock.calls[0];
    const storedWith = (clientId: string) => ({
      _id: "p1",
      pm: { mcpServers: [{ name: "other" }, { name: "acme", oauth: { clientId, accessToken: "", status: "unconfigured" } }] },
    });
    expect(sift(filter)(storedWith("client-1"))).toBe(true);
    expect(sift(filter)(storedWith("client-2"))).toBe(false);
  });

  it("keeps the stored refresh token when the provider does not issue a new one", async () => {
    refreshTokens.mockResolvedValue({ accessToken: "new-access", expiresAt: new Date(Date.now() + hour) });

    await discoverMcpTools("p1", [oauthServer({})]);

    expect(updateOne.mock.calls[0][1].$set["pm.mcpServers.$.oauth.refreshToken"]).toBe("enc:the-refresh");
  });

  it("refreshes a token that is about to expire, not only one that has", async () => {
    refreshTokens.mockResolvedValue({ accessToken: "new-access", expiresAt: new Date(Date.now() + hour) });

    await discoverMcpTools("p1", [oauthServer({ expiresAt: new Date(Date.now() + 30_000) })]);

    expect(refreshTokens).toHaveBeenCalledTimes(1);
  });

  it("marks the server as needing re-authorisation when the refresh fails, and skips it", async () => {
    refreshTokens.mockRejectedValue(new Error("invalid_grant"));

    const runtime = await discoverMcpTools("p1", [oauthServer({})]);

    expect(updateOne).toHaveBeenCalledWith(
      { _id: "p1", "pm.mcpServers": { $elemMatch: { name: "acme", "oauth.clientId": "client-1" } } },
      { $set: { "pm.mcpServers.$.oauth.status": "needs_reauth" } }
    );
    expect(McpClientMock).not.toHaveBeenCalled();
    expect(runtime.serverNames).toEqual([]);
  });

  it("marks an expired token with nothing to refresh it as needing re-authorisation", async () => {
    await discoverMcpTools("p1", [oauthServer({ refreshToken: undefined })]);

    expect(refreshTokens).not.toHaveBeenCalled();
    expect(updateOne).toHaveBeenCalledWith(
      { _id: "p1", "pm.mcpServers": { $elemMatch: { name: "acme", "oauth.clientId": "client-1" } } },
      { $set: { "pm.mcpServers.$.oauth.status": "needs_reauth" } }
    );
  });

  // Refresh tokens are often single-use: two turns refreshing at once would spend it twice
  it("shares one refresh between turns that need it at the same time", async () => {
    let finish!: (v: unknown) => void;
    refreshTokens.mockReturnValue(new Promise((resolve) => (finish = resolve)));

    const both = Promise.all([discoverMcpTools("p1", [oauthServer({})]), discoverMcpTools("p1", [oauthServer({})])]);
    await vi.waitFor(() => expect(refreshTokens).toHaveBeenCalled());
    finish({ accessToken: "new-access", expiresAt: new Date(Date.now() + hour) });
    await both;

    expect(refreshTokens).toHaveBeenCalledTimes(1);
  });
});

// BP-750. A stored expiry saying the token is still good is a local guess; the provider can
// revoke an access token early, and the only way to learn that is the 401 it answers with.
describe("discoverMcpTools — a 401 despite a stored expiry that still looked fresh", () => {
  const rejecting401 = () => ({
    initialize: vi.fn().mockRejectedValue(new McpHttpError(401)),
    listTools: vi.fn(),
  });

  it("retries once after a forced refresh, and serves the tools on the refreshed token", async () => {
    let call = 0;
    McpClientMock.mockImplementation(() =>
      call++ === 0
        ? rejecting401()
        : { initialize: vi.fn().mockResolvedValue(undefined), listTools: vi.fn().mockResolvedValue([{ name: "list_tickets" }]) }
    );
    refreshTokens.mockResolvedValue({
      accessToken: "new-access",
      refreshToken: "new-refresh",
      expiresAt: new Date(Date.now() + hour),
    });

    const runtime = await discoverMcpTools("p1", [oauthServer({ expiresAt: new Date(Date.now() + hour) })]);

    expect(refreshTokens).toHaveBeenCalledTimes(1);
    expect(McpClientMock).toHaveBeenNthCalledWith(1, "https://acme.example/mcp", "old-access");
    expect(McpClientMock).toHaveBeenNthCalledWith(2, "https://acme.example/mcp", "new-access");
    expect(runtime.serverNames).toEqual(["acme"]);
    expect(updateOne.mock.calls[0][1].$set["pm.mcpServers.$.oauth.status"]).toBe("connected");
  });

  it("marks needs_reauth, not connected, when there is nothing to refresh with", async () => {
    McpClientMock.mockImplementation(rejecting401);

    const runtime = await discoverMcpTools("p1", [
      oauthServer({ expiresAt: new Date(Date.now() + hour), refreshToken: undefined }),
    ]);

    expect(refreshTokens).not.toHaveBeenCalled();
    expect(updateOne).toHaveBeenCalledTimes(1);
    expect(updateOne).toHaveBeenCalledWith(
      { _id: "p1", "pm.mcpServers": { $elemMatch: { name: "acme", "oauth.clientId": "client-1" } } },
      { $set: { "pm.mcpServers.$.oauth.status": "needs_reauth" } }
    );
    expect(runtime.serverNames).toEqual([]);
  });

  it("marks needs_reauth when the freshly refreshed token 401s again", async () => {
    McpClientMock.mockImplementation(rejecting401);
    refreshTokens.mockResolvedValue({ accessToken: "new-access", expiresAt: new Date(Date.now() + hour) });

    const runtime = await discoverMcpTools("p1", [oauthServer({ expiresAt: new Date(Date.now() + hour) })]);

    // The refresh's own write says connected; the retry's own failure has the last word.
    const statuses = updateOne.mock.calls.map(([, update]) => update.$set["pm.mcpServers.$.oauth.status"]);
    expect(statuses).toEqual(["connected", "needs_reauth"]);
    expect(runtime.serverNames).toEqual([]);
  });

  it("does not retry a failure that is not a 401, and leaves the stored status untouched", async () => {
    McpClientMock.mockImplementation(() => ({
      initialize: vi.fn().mockRejectedValue(new Error("fetch failed")),
      listTools: vi.fn(),
    }));

    const runtime = await discoverMcpTools("p1", [oauthServer({ expiresAt: new Date(Date.now() + hour) })]);

    expect(refreshTokens).not.toHaveBeenCalled();
    expect(updateOne).not.toHaveBeenCalled();
    expect(runtime.serverNames).toEqual([]);
  });

  it("does not force-refresh a bearer server's 401 — there is no OAuth token to refresh", async () => {
    McpClientMock.mockImplementation(rejecting401);

    const runtime = await discoverMcpTools("p1", [server()]);

    expect(refreshTokens).not.toHaveBeenCalled();
    expect(updateOne).not.toHaveBeenCalled();
    expect(runtime.serverNames).toEqual([]);
  });

  // BP-750 review: `MCP error <code>: <message>` (mcp-client.ts) carries a message the remote
  // server composed. Matching on that text, rather than the transport status, would let a server
  // trigger a refresh it has no business triggering just by mentioning "401" in a message of its
  // own — this one never gets past the initial handshake, let alone into `oauth.status`.
  it("does not force-refresh on a JSON-RPC error that merely mentions 401 in its own message", async () => {
    McpClientMock.mockImplementation(() => ({
      initialize: vi.fn().mockRejectedValue(new Error("MCP error -32000: upstream responded 401")),
      listTools: vi.fn(),
    }));

    const runtime = await discoverMcpTools("p1", [oauthServer({ expiresAt: new Date(Date.now() + hour) })]);

    expect(refreshTokens).not.toHaveBeenCalled();
    expect(updateOne).not.toHaveBeenCalled();
    expect(runtime.serverNames).toEqual([]);
  });

  // BP-750 review: the first attempt's own catch leaves the status untouched on a non-401 (the
  // test above this one, and "does not retry a failure that is not a 401"); the retry's catch had
  // not been held to the same rule — any failure there, transient or not, permanently disabled
  // the connection until a human reconnected it.
  it("does not mark needs_reauth when the retry fails for a reason that is not a 401", async () => {
    let call = 0;
    McpClientMock.mockImplementation(() =>
      call++ === 0
        ? rejecting401()
        : { initialize: vi.fn().mockRejectedValue(new Error("fetch failed")), listTools: vi.fn() }
    );
    refreshTokens.mockResolvedValue({ accessToken: "new-access", expiresAt: new Date(Date.now() + hour) });

    const runtime = await discoverMcpTools("p1", [oauthServer({ expiresAt: new Date(Date.now() + hour) })]);

    // The refresh's own write says connected; nothing overwrites it for a transient retry failure.
    const statuses = updateOne.mock.calls.map(([, update]) => update.$set["pm.mcpServers.$.oauth.status"]);
    expect(statuses).toEqual(["connected"]);
    expect(runtime.serverNames).toEqual([]);
  });

  // BP-750 review: an expired token triggers an ordinary refresh inside resolveServerToken before
  // discoverMcpTools ever gets to try connecting — so the freshly-issued token 401ing too, forcing
  // a *second* refresh in the same call, is not a made-up scenario. persistOauthFields writes the
  // rotated pair to Mongo (the mocked updateOne) but that write alone does not change what the
  // second refresh reads: `oauth` in resolveOauthAccessToken is `server.oauth`, so it has to be
  // the object the first refresh mutated, or the second refresh replays the token the provider
  // already rotated away from.
  it("refreshes with the token the previous refresh in this same call actually rotated to", async () => {
    McpClientMock.mockImplementation(rejecting401);
    let call = 0;
    refreshTokens.mockImplementation(async ({ refreshToken }) => {
      call++;
      if (call === 1) {
        expect(refreshToken).toBe("the-refresh");
        return { accessToken: "access-1", refreshToken: "rotated-refresh", expiresAt: new Date(Date.now() + hour) };
      }
      expect(refreshToken).toBe("rotated-refresh");
      return { accessToken: "access-2", refreshToken: "rotated-refresh-2", expiresAt: new Date(Date.now() + hour) };
    });

    // Already expired: resolveServerToken's own "is it fresh" check triggers refresh #1 before
    // discoverMcpTools makes its first connection attempt at all.
    await discoverMcpTools("p1", [oauthServer({ expiresAt: new Date(Date.now() - 1000) })]);

    expect(refreshTokens).toHaveBeenCalledTimes(2);
  });
});

describe("callMcpTool", () => {
  const tool = (text: string) =>
    ({
      exposedName: "mcp_acme_list_tickets",
      serverName: "acme",
      toolName: "list_tickets",
      write: false,
      definition: {},
      client: { callTool: vi.fn().mockResolvedValue({ text, isError: false }) },
    }) as never;

  it("frames what the server said as data, and cuts it at 8000 characters", async () => {
    const { result } = await callMcpTool(tool("r".repeat(9000)), {});

    expect(result.startsWith('[External content from MCP server "acme"')).toBe(true);
    expect(result).toContain(`${"r".repeat(8000)}\n... (truncated)`);
    expect(result).not.toContain("r".repeat(8001));
  });
});
