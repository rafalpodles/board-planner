import { describe, it, expect, vi, beforeEach } from "vitest";

const getAuthUser = vi.fn();
const pmAvailability = vi.fn();

vi.mock("@/lib/db", () => ({ connectDB: vi.fn() }));
vi.mock("@/lib/auth", () => ({
  getAuthUser,
  RateLimitError: class RateLimitError extends Error {},
}));
vi.mock("@/lib/pm/config", () => ({ pmAvailability }));

const { GET } = await import("./route");

const ctx = () => ({ params: Promise.resolve({}) });
const request = () => new Request("http://localhost/api/projects/setup");

beforeEach(() => {
  vi.clearAllMocks();
  getAuthUser.mockResolvedValue({ _id: "a1", role: "admin" });
});

describe("GET /api/projects/setup", () => {
  it("reports whether a PM agent could run, from the instance and not from a project", async () => {
    pmAvailability.mockResolvedValue({ available: false, needsPlan: true, keyUnreadable: false, locked: false });

    const body = await (await GET(request(), ctx())).json();

    expect(body).toMatchObject({ pmAvailable: false, pmNeedsPlan: true, pmKeyUnreadable: false, pmLocked: false });
  });

  it("says the PM agent is not available when the instance could not be asked", async () => {
    pmAvailability.mockResolvedValue(null);

    const body = await (await GET(request(), ctx())).json();

    expect(body.pmAvailable).toBe(false);
  });

  it("says where a repository address counts as GitHub", async () => {
    pmAvailability.mockResolvedValue(null);

    const body = await (await GET(request(), ctx())).json();

    expect(body.githubWebBase).toMatch(/^https?:\/\//);
  });

  it("is an administrator's", async () => {
    getAuthUser.mockResolvedValue({ _id: "u1", role: "member" });

    const response = await GET(request(), ctx());

    expect(response.status).toBe(403);
    expect(pmAvailability).not.toHaveBeenCalled();
  });
});
