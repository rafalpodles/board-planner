import { describe, it, expect, vi, beforeEach } from "vitest";

const getAuthUser = vi.fn();
const check = vi.fn();
const projectFindById = vi.fn();
const resolveServerToken = vi.fn();
const McpClientMock = vi.fn();

vi.mock("@/lib/db", () => ({ connectDB: vi.fn() }));
vi.mock("@/lib/auth", () => ({
  getAuthUser,
  RateLimitError: class RateLimitError extends Error {},
}));
vi.mock("@/lib/grants", () => ({ check }));
vi.mock("@/models/project", () => ({
  Project: { findById: projectFindById },
}));
vi.mock("@/lib/pm/mcp-tools", () => ({
  resolveServerToken,
  isReadSafe: vi.fn(() => true),
}));
vi.mock("@/lib/pm/mcp-client", () => ({ McpClient: McpClientMock }));

const { POST } = await import("./route");

const OWNER = { _id: "u1", role: "member" };
const MEMBER = { _id: "u2", role: "member" };
const PROJECT_ID = "507f1f77bcf86cd799439011";

function request(body: unknown = {}) {
  return new Request("http://localhost/api/projects/p1/pm/mcp-test", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const ctx = () => ({ params: Promise.resolve({ projectId: PROJECT_ID }) });

function projectWithServer(server: Record<string, unknown>) {
  projectFindById.mockReturnValue({
    select: vi.fn().mockResolvedValue({ pm: { mcpServers: [server] } }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  getAuthUser.mockResolvedValue(OWNER);
  check.mockResolvedValue(true);
  McpClientMock.mockImplementation(() => ({
    initialize: vi.fn().mockResolvedValue(undefined),
    listTools: vi.fn().mockResolvedValue([]),
  }));
});

// Exercises a stored credential through resolveServerToken without ever exposing it, so
// this guard is the only thing standing between a caller and the project's saved secret
describe("POST /api/projects/[projectId]/pm/mcp-test", () => {
  it("admits a project owner past the guard", async () => {
    check.mockResolvedValue(true);

    const response = await POST(request(), ctx());

    expect(response.status).toBe(400);
    expect(check).toHaveBeenCalledWith(expect.anything(), PROJECT_ID, "admin");
  });

  it("denies a plain member", async () => {
    check.mockResolvedValue(false);
    getAuthUser.mockResolvedValue(MEMBER);

    const response = await POST(request(), ctx());

    expect(response.status).toBe(403);
  });
});

// A malicious owner can point `url` anywhere while naming a saved server so the route
// resolves a real secret — the outbound client's constructor args are the only place
// that proves whether the resolved token followed body.url or stayed on server.url.
describe("stored credentials never leave their saved url", () => {
  it("sends a resolved OAuth token to the server's saved url, not the caller-supplied one", async () => {
    projectWithServer({ name: "notion", url: "https://good.example/mcp", authType: "oauth" });
    resolveServerToken.mockResolvedValue("plaintext-oauth-access-token");

    const response = await POST(
      request({ name: "notion", url: "https://attacker.example/mcp", authType: "oauth" }),
      ctx()
    );

    expect(response.status).toBe(200);
    expect(McpClientMock).toHaveBeenCalledWith("https://good.example/mcp", "plaintext-oauth-access-token");
    expect(McpClientMock).not.toHaveBeenCalledWith("https://attacker.example/mcp", expect.anything());
  });

  it("sends a resolved bearer token to the server's saved url, not the caller-supplied one", async () => {
    projectWithServer({ name: "jira", url: "https://good.example/mcp", authType: "bearer", authToken: "enc" });
    resolveServerToken.mockResolvedValue("plaintext-bearer-token");

    const response = await POST(
      request({ name: "jira", url: "https://attacker.example/mcp", authType: "bearer" }),
      ctx()
    );

    expect(response.status).toBe(200);
    expect(McpClientMock).toHaveBeenCalledWith("https://good.example/mcp", "plaintext-bearer-token");
    expect(McpClientMock).not.toHaveBeenCalledWith("https://attacker.example/mcp", expect.anything());
  });

  it("still tests a caller-supplied url when the token is supplied inline, not stored", async () => {
    const response = await POST(
      request({ url: "https://caller-chosen.example/mcp", authType: "bearer", authToken: "user-typed-token" }),
      ctx()
    );

    expect(response.status).toBe(200);
    expect(McpClientMock).toHaveBeenCalledWith("https://caller-chosen.example/mcp", "user-typed-token");
    expect(projectFindById).not.toHaveBeenCalled();
  });

  it("still validates the stored server's own url before using it", async () => {
    projectWithServer({ name: "internal", url: "https://10.0.0.5/mcp", authType: "bearer", authToken: "enc" });
    resolveServerToken.mockResolvedValue("plaintext-token");

    const response = await POST(
      request({ name: "internal", url: "https://attacker.example/mcp", authType: "bearer" }),
      ctx()
    );

    expect(response.status).toBe(400);
    expect(McpClientMock).not.toHaveBeenCalled();
  });
});

// The picker in Settings is only usable if it can say what each tool does. `listTools` returns a
// description per tool and this route used to map it away, which is why the allowlist had to be
// typed from memory (BP-569).
describe("the tool list carries enough to choose from", () => {
  const TOOLS = [
    { name: "notion-search", description: "Search pages in the workspace" },
    { name: "notion-update-page", description: "Append blocks to a page" },
    { name: "notion-orphan" },
  ];

  beforeEach(() => {
    McpClientMock.mockImplementation(() => ({
      initialize: vi.fn().mockResolvedValue(undefined),
      listTools: vi.fn().mockResolvedValue(TOOLS),
    }));
  });

  it("returns each tool's description alongside its name", async () => {
    const response = await POST(
      request({ url: "https://mcp.example/mcp", authType: "bearer", authToken: "t" }),
      ctx()
    );
    const body = await response.json();

    expect(body.count).toBe(3);
    expect(body.tools).toEqual([
      { name: "notion-search", description: "Search pages in the workspace", readSafe: true },
      { name: "notion-update-page", description: "Append blocks to a page", readSafe: true },
      { name: "notion-orphan", description: "", readSafe: true },
    ]);
  });
});
