import { describe, it, expect, vi, beforeEach } from "vitest";

const getAuthUser = vi.fn();
const grantFindLean = vi.fn();
const userFind = vi.fn();
const userFindLean = vi.fn();
const check = vi.fn();

vi.mock("@/lib/db", () => ({ connectDB: vi.fn() }));
vi.mock("@/lib/auth", () => ({
  getAuthUser,
  RateLimitError: class RateLimitError extends Error {},
}));
vi.mock("@/lib/grants", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/grants")>();
  return { ...actual, check, accessibleProjectIds: vi.fn() };
});
vi.mock("@/models/grant", () => ({
  Grant: { find: () => ({ select: () => ({ lean: grantFindLean }) }) },
}));
vi.mock("@/models/user", () => ({
  User: {
    find: (...a: unknown[]) => (userFind(...a), { sort: () => ({ lean: userFindLean }) }),
  },
}));
vi.mock("@/models/project", () => ({ Project: { findOne: vi.fn() } }));
vi.mock("@/models/task", () => ({ Task: {} }));

const { GET } = await import("./route");

const PROJECT = "69a52e3b399b27d3cbb2c5a5";
const params = Promise.resolve({ projectId: PROJECT });
const U1 = "507f1f77bcf86cd799439011";

beforeEach(() => {
  vi.clearAllMocks();
  getAuthUser.mockResolvedValue({ _id: "o1", role: "member" });
  check.mockResolvedValue(true);
  grantFindLean.mockResolvedValue([]);
  userFindLean.mockResolvedValue([]);
});

describe("GET assignable-users", () => {
  it("asks only for people this board reaches, plus instance admins", async () => {
    grantFindLean.mockResolvedValue([{ subject: U1 }]);

    await GET(new Request("http://x"), { params });

    expect(userFind).toHaveBeenCalledWith(
      {
        kind: { $ne: "machine" },
        $or: [{ role: "admin" }, { _id: { $in: [U1] } }],
      },
      "username fullName"
    );
  });

  it("never offers a machine account", async () => {
    await GET(new Request("http://x"), { params });

    expect(userFind.mock.calls[0][0]).toMatchObject({ kind: { $ne: "machine" } });
  });

  it("sends only what naming somebody needs", async () => {
    await GET(new Request("http://x"), { params });

    expect(userFind.mock.calls[0][1]).toBe("username fullName");
  });

  it("refuses a reader who cannot reach the board", async () => {
    check.mockResolvedValue(false);

    const response = await GET(new Request("http://x"), { params });

    expect(response.status).toBe(403);
    expect(userFind).not.toHaveBeenCalled();
  });
});
