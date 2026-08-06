import { describe, it, expect, vi, beforeEach } from "vitest";

const getAuthUser = vi.fn();
const check = vi.fn();
const userFindById = vi.fn();
const userCountDocuments = vi.fn();

vi.mock("@/lib/db", () => ({ connectDB: vi.fn() }));
vi.mock("@/lib/auth", () => ({
  getAuthUser,
  RateLimitError: class RateLimitError extends Error {},
}));
vi.mock("@/lib/grants", () => ({ check, accessibleProjectIds: vi.fn() }));
vi.mock("@/models/user", () => ({
  User: {
    findById: userFindById,
    countDocuments: userCountDocuments,
    findByIdAndDelete: vi.fn(),
  },
}));

const { PUT } = await import("./route");

const ADMIN = { _id: "admin-1", role: "admin" };

function put(body: unknown) {
  return new Request("http://x/api/users/target-1", {
    method: "PUT",
    body: JSON.stringify(body),
  });
}

const ctx = () => ({ params: Promise.resolve({ userId: "target-1" }) });

function targetDoc(overrides: Record<string, unknown> = {}) {
  return {
    _id: "target-1",
    role: "admin",
    allowedProjects: ["original"],
    save: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  getAuthUser.mockResolvedValue(ADMIN);
  userCountDocuments.mockResolvedValue(2);
});

describe("PUT /api/users/:id", () => {
  // Board access now lives entirely in the grants collection; a client still sending
  // allowedProjects here (an old build, a stale bookmarklet) must not write it back onto the user
  it("updates the role and leaves allowedProjects untouched", async () => {
    const target = targetDoc();
    userFindById.mockResolvedValue(target);

    const res = await PUT(put({ role: "member", allowedProjects: ["p1"] }), ctx());

    expect(res.status).toBe(200);
    expect(target.role).toBe("member");
    expect(target.allowedProjects).toEqual(["original"]);
    expect(target.save).toHaveBeenCalled();
  });
});
