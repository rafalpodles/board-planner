import { describe, it, expect, vi, beforeEach } from "vitest";

const getAuthUser = vi.fn();
const check = vi.fn();
const projectFindById = vi.fn();

vi.mock("@/lib/db", () => ({ connectDB: vi.fn() }));
vi.mock("@/lib/auth", () => ({
  getAuthUser,
  RateLimitError: class RateLimitError extends Error {},
}));
vi.mock("@/lib/grants", () => ({ check }));
vi.mock("@/models/project", () => ({
  Project: { findById: projectFindById },
}));

const { POST } = await import("./route");

const OWNER = { _id: "u1", role: "member" };
const MEMBER = { _id: "u2", role: "member" };
const PROJECT_ID = "507f1f77bcf86cd799439011";

function request(body: unknown = { name: "srv" }) {
  return new Request("http://localhost/api/projects/p1/pm/mcp-oauth/start", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const ctx = () => ({ params: Promise.resolve({ projectId: PROJECT_ID }) });

beforeEach(() => {
  vi.clearAllMocks();
  getAuthUser.mockResolvedValue(OWNER);
  projectFindById.mockResolvedValue(null);
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
