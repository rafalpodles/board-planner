import { describe, it, expect, vi, beforeEach } from "vitest";

const getAuthUser = vi.fn();
const userFind = vi.fn();
const userSelect = vi.fn();
const userFindLean = vi.fn();

vi.mock("@/lib/db", () => ({ connectDB: vi.fn() }));
vi.mock("@/lib/auth", () => ({
  getAuthUser,
  RateLimitError: class RateLimitError extends Error {},
}));
vi.mock("@/models/user", () => ({
  User: {
    find: (...a: unknown[]) => (
      userFind(...a),
      {
        select: (...s: unknown[]) => (
          userSelect(...s), { sort: () => ({ lean: userFindLean }) }
        ),
      }
    ),
  },
}));

const { GET } = await import("./route");

const call = () => GET(new Request("http://x/api/users/admins"), { params: Promise.resolve({}) });

beforeEach(() => {
  vi.clearAllMocks();
  getAuthUser.mockResolvedValue({ _id: "m1", role: "member" });
  userFindLean.mockResolvedValue([]);
});

describe("GET /api/users/admins", () => {
  it("answers a member with the instance admins' names and nothing else", async () => {
    userFindLean.mockResolvedValue([
      { _id: "a1", fullName: "Agnieszka Nowak", username: "agnieszka", email: "a@x.io" },
      { _id: "a2", fullName: "Tomasz Wójcik", username: "tomasz", email: "t@x.io" },
    ]);

    const res = await call();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([
      { fullName: "Agnieszka Nowak" },
      { fullName: "Tomasz Wójcik" },
    ]);
  });

  it("asks only for people who are admins, never machines, and reads only their name", async () => {
    await call();

    expect(userFind).toHaveBeenCalledWith({ role: "admin", kind: { $ne: "machine" } });
    expect(userSelect).toHaveBeenCalledWith("fullName");
  });

  it("refuses somebody who is not signed in", async () => {
    getAuthUser.mockResolvedValue(null);

    const res = await call();

    expect(res.status).toBe(401);
    expect(userFind).not.toHaveBeenCalled();
  });
});
