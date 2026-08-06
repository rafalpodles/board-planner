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
    email: "target@example.com",
    kind: "human",
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
  // Board access lives entirely in the grants collection now, so this endpoint's whole job is the
  // role. Anything else a client sends — an old build, a stale bookmarklet, a hostile caller —
  // must not reach the document.
  it("writes the role and nothing else the body carries", async () => {
    const target = targetDoc();
    userFindById.mockResolvedValue(target);

    const res = await PUT(
      put({ role: "member", email: "hijack@example.com", kind: "machine" }),
      ctx()
    );

    expect(res.status).toBe(200);
    expect(target.role).toBe("member");
    expect(target.email).toBe("target@example.com");
    expect(target.kind).toBe("human");
    expect(target.save).toHaveBeenCalled();
  });
});
