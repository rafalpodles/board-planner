import { describe, it, expect, vi, beforeEach } from "vitest";

const getAuthUser = vi.fn();
const check = vi.fn();
const findOne = vi.fn();
const lean = vi.fn();
const pmDayUsage = vi.fn();

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
vi.mock("@/models/project", () => ({
  Project: { findOne: (...a: unknown[]) => (findOne(...a), { lean }) },
}));
vi.mock("@/lib/pm/day-usage", () => ({ pmDayUsage }));
vi.mock("@/lib/pm/agent", () => ({ MAX_STEPS: 15 }));

const { GET } = await import("./route");
const { scopedToDefaultOrganisation } = await import("@/lib/db-scope");

const PROJECT = "69a52e3b399b27d3cbb2c5a5";
const params = Promise.resolve({ projectId: PROJECT });

beforeEach(() => {
  vi.clearAllMocks();
  getAuthUser.mockResolvedValue({ _id: "u1", role: "member" });
  check.mockResolvedValue(true);
  lean.mockResolvedValue({ pm: {} });
  pmDayUsage.mockResolvedValue({
    turns: 0,
    calls: 0,
    tokens: 0,
    promptTokens: 0,
    cachedTokens: 0,
    cacheWriteTokens: 0,
    stepLimitHits: 0,
  });
});

/**
 * BP-562. Same shape as BP-549: the settings screen only offers PM usage inside its
 * `projectAdmin` section (`project.canAdmin`, i.e. `check(user, projectId, "admin")`), so the
 * route has to ask for the same thing or a member reads via the API what the screen withholds.
 */
describe("GET pm/usage", () => {
  it("checks admin-level access, not mere board access", async () => {
    await GET(new Request("http://x"), { params });

    expect(check).toHaveBeenCalledWith(scopedToDefaultOrganisation(), expect.anything(), PROJECT, "admin");
  });

  it("refuses a member who is not the project's owner", async () => {
    check.mockResolvedValue(false);

    const response = await GET(new Request("http://x"), { params });

    expect(response.status).toBe(403);
    expect(findOne).not.toHaveBeenCalled();
  });

  it("serves usage to the project owner", async () => {
    const response = await GET(new Request("http://x"), { params });

    expect(response.status).toBe(200);
  });

  /**
   * BP-568. The figures exist in the aggregate and are read on the settings screen; a route that
   * computed them and left them out of the body is exactly the silent gap this ticket is about,
   * and nothing else in the chain would have failed.
   */
  it("reports what was served from cache, beside the tokens it is part of", async () => {
    pmDayUsage.mockResolvedValue({
      turns: 3,
      calls: 12,
      tokens: 120_000,
      promptTokens: 100_000,
      cachedTokens: 90_000,
      cacheWriteTokens: 4_000,
      stepLimitHits: 0,
    });

    const body = await (await GET(new Request("http://x"), { params })).json();

    // `promptTokens` is what the screen divides the cached figure by; without it in the body the
    // page can only divide by the day's total, which folds in everything the model wrote
    expect(body).toMatchObject({
      tokens: 120_000,
      promptTokens: 100_000,
      cachedTokens: 90_000,
      cacheWriteTokens: 4_000,
    });
  });

  // BP-679: there is no cap on the screen any more, so the body carries no number that looks like one
  it("reports the day's turns, calls and tokens, and no cap", async () => {
    pmDayUsage.mockResolvedValue({ turns: 3, calls: 12, tokens: 120_000, promptTokens: 0, cachedTokens: 0, cacheWriteTokens: 0, stepLimitHits: 1 });

    const body = await (await GET(new Request("http://x"), { params })).json();

    expect(body).toEqual({
      turns: 3,
      calls: 12,
      tokens: 120_000,
      promptTokens: 0,
      cachedTokens: 0,
      cacheWriteTokens: 0,
      stepLimitHits: 1,
      maxCallsPerTurn: 15,
    });
  });
});
