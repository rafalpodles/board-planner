import { describe, it, expect, vi, beforeEach } from "vitest";

const findOneAndDelete = vi.fn();

vi.mock("@/lib/db", () => ({ connectDB: vi.fn() }));
vi.mock("@/models/pmOauthState", () => ({ PmOauthState: { findOneAndDelete } }));
vi.mock("@/models/project", () => ({ Project: { findById: vi.fn() } }));
vi.mock("@/lib/encryption", () => ({ decryptSecret: (v: string) => v, encryptSecret: (v: string) => v }));
vi.mock("@/lib/pm/mcp-oauth", () => ({
  exchangeCode: vi.fn(),
  getPmOauthRedirectUri: () => "https://board.example.com/api/pm/oauth/callback",
}));

const { GET } = await import("./route");

function request(headers: Record<string, string> = {}) {
  return new Request("https://board.example.com/api/pm/oauth/callback?state=nope", { headers });
}

beforeEach(() => {
  vi.clearAllMocks();
  findOneAndDelete.mockResolvedValue(null);
});

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
    findOneAndDelete.mockResolvedValue({ project: "p1", serverName: "notion" });

    const res = await GET(
      new Request("https://board.example.com/api/pm/oauth/callback?state=s&error=access_denied")
    );

    expect(res.headers.get("location")).toBe(
      "/projects/p1/settings?mcp_oauth=error%3Aaccess_denied"
    );
  });
});
