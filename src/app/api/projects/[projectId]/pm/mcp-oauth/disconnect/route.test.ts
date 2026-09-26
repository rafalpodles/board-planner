import { describe, it, expect, vi, beforeEach } from "vitest";

const getAuthUser = vi.fn();
const check = vi.fn();
const projectFindOneAndUpdate = vi.fn();
const projectExists = vi.fn();
const logProjectAudit = vi.fn();

vi.mock("@/lib/db", () => ({ connectDB: vi.fn() }));
vi.mock("@/lib/auth", () => ({
  getAuthUser,
  RateLimitError: class RateLimitError extends Error {},
}));
vi.mock("@/lib/grants", () => ({ check }));
vi.mock("@/lib/projectAudit", () => ({ logProjectAudit }));
vi.mock("@/models/project", () => ({
  Project: { findOneAndUpdate: projectFindOneAndUpdate, exists: projectExists },
}));

const { POST } = await import("./route");

const OWNER = { _id: "u1", role: "member" };
const MEMBER = { _id: "u2", role: "member" };
const PROJECT_ID = "507f1f77bcf86cd799439011";

function request(body: unknown = { name: "srv" }) {
  return new Request("http://localhost/api/projects/p1/pm/mcp-oauth/disconnect", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const ctx = () => ({ params: Promise.resolve({ projectId: PROJECT_ID }) });

function before(oauth: Record<string, unknown> | null) {
  const image = oauth && { _id: PROJECT_ID, pm: { mcpServers: [{ name: "srv", authType: "oauth", oauth }] } };
  projectFindOneAndUpdate.mockReturnValue({ lean: () => Promise.resolve(image) });
}

beforeEach(() => {
  vi.clearAllMocks();
  getAuthUser.mockResolvedValue(OWNER);
  check.mockResolvedValue(true);
  before(null);
  projectExists.mockResolvedValue(null);
});

describe("POST /api/projects/[projectId]/pm/mcp-oauth/disconnect", () => {
  it("admits a project owner past the guard", async () => {
    const response = await POST(request(), ctx());

    expect(response.status).toBe(404);
    expect(projectFindOneAndUpdate).toHaveBeenCalled();
    expect(check).toHaveBeenCalledWith(expect.anything(), PROJECT_ID, "admin");
  });

  it("denies a plain member", async () => {
    check.mockResolvedValue(false);
    getAuthUser.mockResolvedValue(MEMBER);

    const response = await POST(request(), ctx());

    expect(response.status).toBe(403);
    expect(projectFindOneAndUpdate).not.toHaveBeenCalled();
  });
});

// BP-782 and BP-786: dropping a connection saved the whole server list back, and left no trace
describe("POST /api/projects/[projectId]/pm/mcp-oauth/disconnect — what it writes and records", () => {
  it("clears the tokens of that one server in one write, keeping its client", async () => {
    before({ clientId: "c1", accessToken: "enc:a", refreshToken: "enc:r", status: "connected" });

    const res = await POST(request(), ctx());

    expect(res.status).toBe(200);
    expect(projectFindOneAndUpdate).toHaveBeenCalledWith(
      { _id: PROJECT_ID, "pm.mcpServers": { $elemMatch: { name: "srv", oauth: { $exists: true, $ne: null } } } },
      {
        $set: {
          "pm.mcpServers.$.oauth.accessToken": "",
          "pm.mcpServers.$.oauth.refreshToken": "",
          "pm.mcpServers.$.oauth.expiresAt": null,
          "pm.mcpServers.$.oauth.status": "unconfigured",
        },
      },
      { returnDocument: "before" }
    );
  });

  it("records the connection it dropped", async () => {
    before({ clientId: "c1", accessToken: "enc:a", status: "connected" });

    await POST(request(), ctx());

    expect(logProjectAudit).toHaveBeenCalledWith(
      PROJECT_ID,
      "u1",
      "settings_updated",
      "PM MCP server srv · OAuth: connected → unconfigured"
    );
  });

  it("records tokens it cleared from a connection already marked unconfigured", async () => {
    before({ clientId: "c1", refreshToken: "enc:r", status: "unconfigured" });

    await POST(request(), ctx());

    expect(logProjectAudit).toHaveBeenCalledWith(
      PROJECT_ID,
      "u1",
      "settings_updated",
      "PM MCP server srv · OAuth tokens cleared"
    );
  });

  it("records nothing when there was nothing to drop", async () => {
    before({ clientId: "c1", accessToken: "", refreshToken: "", status: "unconfigured" });

    const res = await POST(request(), ctx());

    expect(res.status).toBe(200);
    expect(logProjectAudit).not.toHaveBeenCalled();
  });

  it("tells a server with no connection from a project that is gone", async () => {
    projectExists.mockResolvedValue({ _id: PROJECT_ID });

    const res = await POST(request(), ctx());

    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe('No OAuth connection named "srv"');
  });

  it("writes nothing for a name that is not a string", async () => {
    projectExists.mockResolvedValue({ _id: PROJECT_ID });

    const res = await POST(request({ name: { $ne: "" } }), ctx());

    expect(res.status).toBe(404);
    expect(projectFindOneAndUpdate).not.toHaveBeenCalled();
  });
});
