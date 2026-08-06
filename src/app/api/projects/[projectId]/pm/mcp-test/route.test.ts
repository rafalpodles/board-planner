import { describe, it, expect, vi, beforeEach } from "vitest";

const getAuthUser = vi.fn();
const check = vi.fn();

vi.mock("@/lib/db", () => ({ connectDB: vi.fn() }));
vi.mock("@/lib/auth", () => ({
  getAuthUser,
  RateLimitError: class RateLimitError extends Error {},
}));
vi.mock("@/lib/grants", () => ({ check }));

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

beforeEach(() => {
  vi.clearAllMocks();
  getAuthUser.mockResolvedValue(OWNER);
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
