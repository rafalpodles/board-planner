import { describe, it, expect, vi, beforeEach } from "vitest";

const getAuthUser = vi.fn();
const projectFind = vi.fn();
const pmAvailability = vi.hoisted(() => vi.fn());

vi.mock("@/lib/db", () => ({ connectDB: vi.fn() }));
vi.mock("@/lib/auth", () => ({ getAuthUser, RateLimitError: class RateLimitError extends Error {} }));
vi.mock("@/lib/grants", () => ({ check: vi.fn(), accessibleProjectIds: vi.fn() }));
vi.mock("@/models/settings", () => ({ getSettings: async () => ({ pmDefaultModel: "", pmDefaultDailyTurnCap: 0 }) }));
vi.mock("@/models/project", () => ({ Project: { find: projectFind } }));
vi.mock("@/lib/pm/config", () => ({ pmAvailability }));
vi.mock("@/lib/pm/openrouter", () => ({ DEFAULT_PM_MODEL: () => "e2e/model" }));

const { GET } = await import("./route");

const ADMIN = { _id: "a1", username: "root", role: "admin", viaMachineCredential: false };
const ask = () => GET(new Request("http://x/api/admin/agents"), { params: Promise.resolve({}) });

beforeEach(() => {
  vi.clearAllMocks();
  getAuthUser.mockResolvedValue(ADMIN);
  projectFind.mockReturnValue({ sort: () => ({ lean: async () => [] }) });
});

// BP-652: the banner on this screen depends on why no agent can run
describe("GET /api/admin/agents", () => {
  it.each([
    ["can run", { available: true, needsPlan: false, keyUnreadable: false }],
    ["could run on a plan", { available: false, needsPlan: true, keyUnreadable: false }],
    ["has a stored key that cannot be read", { available: false, needsPlan: false, keyUnreadable: true }],
  ])("passes on whether the PM agent %s", async (_case, availability) => {
    pmAvailability.mockResolvedValue(availability);

    const body = await (await ask()).json();

    expect(body).toMatchObject({
      pmAvailable: availability.available,
      pmNeedsPlan: availability.needsPlan,
      pmKeyUnreadable: availability.keyUnreadable,
    });
  });

  it("says the agent cannot run, rather than failing, when availability cannot be read", async () => {
    pmAvailability.mockResolvedValue(null);

    expect(await (await ask()).json()).toMatchObject({ pmAvailable: false, pmNeedsPlan: false, pmKeyUnreadable: false });
  });

  it("answers no member", async () => {
    getAuthUser.mockResolvedValue({ ...ADMIN, role: "member" });

    expect((await ask()).status).toBe(403);
  });
});
