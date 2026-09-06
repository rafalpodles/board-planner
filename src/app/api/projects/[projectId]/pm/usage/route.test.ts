import { describe, it, expect, vi, beforeEach } from "vitest";

const getAuthUser = vi.fn();
const check = vi.fn();
const findById = vi.fn();
const lean = vi.fn();
const isOverDailyTurnCap = vi.fn();
const dailyPmSpend = vi.fn();

vi.mock("@/lib/db", () => ({ connectDB: vi.fn() }));
vi.mock("@/lib/auth", () => ({
  getAuthUser,
  RateLimitError: class RateLimitError extends Error {},
}));
vi.mock("@/lib/grants", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/grants")>();
  return { ...actual, check };
});
vi.mock("@/models/project", () => ({
  Project: { findById: (...a: unknown[]) => (findById(...a), { lean }) },
}));
vi.mock("@/lib/pm/turn-cap", () => ({ isOverDailyTurnCap, dailyPmSpend }));
vi.mock("@/lib/pm/agent", () => ({ MAX_STEPS: 15 }));

const { GET } = await import("./route");

const PROJECT = "69a52e3b399b27d3cbb2c5a5";
const params = Promise.resolve({ projectId: PROJECT });

beforeEach(() => {
  vi.clearAllMocks();
  getAuthUser.mockResolvedValue({ _id: "u1", role: "member" });
  check.mockResolvedValue(true);
  lean.mockResolvedValue({ pm: {} });
  isOverDailyTurnCap.mockResolvedValue({ used: 0, cap: 0 });
  dailyPmSpend.mockResolvedValue({ calls: 0, tokens: 0, cap: 0, stepLimitHits: 0 });
});

describe("GET pm/usage", () => {
  it("checks admin-level access, not mere board access", async () => {
    await GET(new Request("http://x"), { params });

    expect(check).toHaveBeenCalledWith(expect.anything(), PROJECT, "admin");
  });

  it("refuses a member who is not the project's owner", async () => {
    check.mockResolvedValue(false);

    const response = await GET(new Request("http://x"), { params });

    expect(response.status).toBe(403);
    expect(findById).not.toHaveBeenCalled();
  });

  it("serves usage to the project owner", async () => {
    const response = await GET(new Request("http://x"), { params });

    expect(response.status).toBe(200);
  });
});
