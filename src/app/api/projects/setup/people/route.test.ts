import { describe, it, expect, vi, beforeEach } from "vitest";
import { DEFAULT_ORGANISATION_ID } from "@/lib/organisation-field";

const getAuthUser = vi.fn();
const userFind = vi.fn();
const sort = vi.fn();
const limit = vi.fn();

vi.mock("@/lib/db", () => ({ connectDB: vi.fn() }));
vi.mock("@/lib/auth", () => ({
  getAuthUser,
  RateLimitError: class RateLimitError extends Error {},
}));
vi.mock("@/models/user", () => ({ User: { find: userFind } }));

const { GET } = await import("./route");

const ADMIN = { _id: "a1", role: "admin" };
const MEMBER = { _id: "u1", role: "member" };
const ctx = () => ({ params: Promise.resolve({}) });
const search = (q?: string) =>
  new Request(`http://localhost/api/projects/setup/people${q === undefined ? "" : `?q=${encodeURIComponent(q)}`}`);

beforeEach(() => {
  vi.clearAllMocks();
  getAuthUser.mockResolvedValue(ADMIN);
  limit.mockReturnValue({ lean: () => Promise.resolve([{ _id: "u2", username: "anna", fullName: "Anna K" }]) });
  sort.mockReturnValue({ limit });
  userFind.mockReturnValue({ select: () => ({ sort }) });
});

describe("GET /api/projects/setup/people", () => {
  it("answers an administrator's search with the first ten matches by username", async () => {
    const response = await GET(search("an"), ctx());

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([{ _id: "u2", username: "anna", fullName: "Anna K" }]);
    expect(sort).toHaveBeenCalledWith({ username: 1 });
    expect(limit).toHaveBeenCalledWith(10);
  });

  it("looks at live human accounts, never the caller, matching username or name", async () => {
    await GET(search("an"), ctx());

    const filter = userFind.mock.calls[0][0];
    expect(filter).toMatchObject({
      kind: { $ne: "machine" },
      deactivatedAt: null,
      _id: { $ne: ADMIN._id },
      organisation: DEFAULT_ORGANISATION_ID,
    });
    expect(filter.$or).toHaveLength(2);
    expect(filter.$or[0].username).toBeInstanceOf(RegExp);
  });

  // The query is user input going into a RegExp: "a.*" must find the letters, not everybody
  it("matches the query literally, not as a pattern", async () => {
    await GET(search("a.*"), ctx());

    const pattern = userFind.mock.calls[0][0].$or[0].username as RegExp;
    expect(pattern.test("a.*")).toBe(true);
    expect(pattern.test("anna")).toBe(false);
  });

  it.each([[undefined], [""], ["a"], [" a "]])("does not search for %j", async (q) => {
    const response = await GET(search(q), ctx());

    expect(await response.json()).toEqual([]);
    expect(userFind).not.toHaveBeenCalled();
  });

  it("is an administrator's, as creating the board is", async () => {
    getAuthUser.mockResolvedValue(MEMBER);

    const response = await GET(search("an"), ctx());

    expect(response.status).toBe(403);
    expect(userFind).not.toHaveBeenCalled();
  });
});
