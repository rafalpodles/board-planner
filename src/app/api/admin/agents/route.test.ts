import { describe, it, expect, vi, beforeEach } from "vitest";

const getAuthUser = vi.fn();
const projectFind = vi.fn();
const pmAvailability = vi.hoisted(() => vi.fn());

vi.mock("@/lib/db", () => ({ connectDB: vi.fn() }));
vi.mock("@/lib/auth", () => ({ getAuthUser, RateLimitError: class RateLimitError extends Error {} }));
vi.mock("@/lib/grants", () => ({ check: vi.fn(), accessibleProjectIds: vi.fn() }));
vi.mock("@/models/settings", () => ({ getSettings: async () => ({ aiModel: "e2e/model" }) }));
vi.mock("@/models/project", () => ({ Project: { find: projectFind } }));
vi.mock("@/lib/pm/config", () => ({ pmAvailability }));

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
    ["is switched off by the operator", { available: false, needsPlan: false, keyUnreadable: false, locked: true }],
  ])("passes on whether the PM agent %s", async (_case, availability) => {
    pmAvailability.mockResolvedValue(availability);

    const body = await (await ask()).json();

    expect(body).toMatchObject({
      pmAvailable: availability.available,
      pmNeedsPlan: availability.needsPlan,
      pmKeyUnreadable: availability.keyUnreadable,
      pmLocked: Boolean((availability as { locked?: boolean }).locked),
    });
  });

  it("says the agent cannot run, rather than failing, when availability cannot be read", async () => {
    pmAvailability.mockResolvedValue(null);

    expect(await (await ask()).json()).toMatchObject({ pmAvailable: false, pmNeedsPlan: false, pmKeyUnreadable: false, pmLocked: false });
  });

  it("names the one instance model, which AI Assist uses as well", async () => {
    pmAvailability.mockResolvedValue({ available: true });

    expect((await (await ask()).json()).defaults).toEqual({ aiModel: "e2e/model" });
  });

  it("answers no member", async () => {
    getAuthUser.mockResolvedValue({ ...ADMIN, role: "member" });

    expect((await ask()).status).toBe(403);
  });
});
