import { describe, it, expect, vi, beforeEach } from "vitest";

const getAuthUser = vi.fn();
const check = vi.fn();
const find = vi.fn();
const populate = vi.fn();
const sort = vi.fn();
const limit = vi.fn();
const lean = vi.fn();

vi.mock("@/lib/db", () => ({ connectDB: vi.fn() }));
vi.mock("@/lib/auth", () => ({
  getAuthUser,
  RateLimitError: class RateLimitError extends Error {},
}));
// `check` is stubbed because withProjectOwner itself is not what is under test here — only which
// need it asks grants.check for.
vi.mock("@/lib/grants", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/grants")>();
  return { ...actual, check };
});
vi.mock("@/models/projectAuditLog", () => ({
  ProjectAuditLog: { find: (...a: unknown[]) => (find(...a), { populate }) },
}));

const { GET } = await import("./route");

const PROJECT = "69a52e3b399b27d3cbb2c5a5";
const params = Promise.resolve({ projectId: PROJECT });

beforeEach(() => {
  vi.clearAllMocks();
  getAuthUser.mockResolvedValue({ _id: "u1", role: "member" });
  check.mockResolvedValue(true);
  populate.mockReturnValue({ sort });
  sort.mockReturnValue({ limit });
  limit.mockReturnValue({ lean });
  lean.mockResolvedValue([]);
});

/**
 * BP-549. The settings screen only offers this section at `project.canAdmin`
 * (`check(user, projectId, "admin")`) — the route has to ask grants for the same thing, or a
 * member reads via the API exactly what the screen withholds from them.
 */
describe("GET audit", () => {
  it("checks admin-level access, not mere board access", async () => {
    await GET(new Request("http://x"), { params });

    expect(check).toHaveBeenCalledWith(expect.anything(), PROJECT, "admin");
  });

  it("refuses a member who is not the project's owner", async () => {
    check.mockResolvedValue(false);

    const response = await GET(new Request("http://x"), { params });

    expect(response.status).toBe(403);
    expect(find).not.toHaveBeenCalled();
  });

  it("serves the log to the project owner", async () => {
    lean.mockResolvedValue([{ _id: "l1" }]);

    const response = await GET(new Request("http://x"), { params });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([{ _id: "l1" }]);
  });
});
