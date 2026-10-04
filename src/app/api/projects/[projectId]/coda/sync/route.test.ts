import { describe, it, expect, vi, beforeEach } from "vitest";

const getAuthUser = vi.fn();
const check = vi.fn();
const syncProjectToCoda = vi.fn();
const plan = vi.hoisted(() => ({ value: "pro" as "free" | "pro" }));

vi.mock("@/lib/db", () => ({ connectDB: vi.fn() }));
vi.mock("@/lib/auth", () => ({ getAuthUser }));
vi.mock("@/lib/grants", () => ({ check }));
vi.mock("@/lib/tenant", () => ({
  getTenant: async () => ({ _id: "t1", entitlements: { plan: plan.value, features: [] } }),
}));
vi.mock("@/ee/connectors/coda/sync", () => ({ syncProjectToCoda }));

const { POST } = await import("./route");
const { scopedToDefaultTenant } = await import("@/lib/db-scope");

const PROJECT_ID = "507f1f77bcf86cd799439011";
const sync = () =>
  POST(new Request(`http://localhost/api/projects/${PROJECT_ID}/coda/sync`, { method: "POST" }), {
    params: Promise.resolve({ projectId: PROJECT_ID }),
  });

beforeEach(() => {
  vi.clearAllMocks();
  plan.value = "pro";
  getAuthUser.mockResolvedValue({ _id: "u1", role: "member" });
  check.mockResolvedValue(true);
  syncProjectToCoda.mockResolvedValue(Response.json({ synced: true }));
});

describe("POST /api/projects/[projectId]/coda/sync", () => {
  it("syncs the project on a Pro instance", async () => {
    const res = await sync();

    expect(res.status).toBe(200);
    expect(syncProjectToCoda).toHaveBeenCalledWith(scopedToDefaultTenant(), PROJECT_ID);
  });

  it("answers 402 on a free instance, without syncing", async () => {
    plan.value = "free";

    const res = await sync();

    expect(res.status).toBe(402);
    expect(await res.json()).toMatchObject({ feature: "integrations.coda", plan: "free" });
    expect(syncProjectToCoda).not.toHaveBeenCalled();
  });

  it("still answers a person who does not own the board with 403 before any plan question", async () => {
    plan.value = "free";
    check.mockResolvedValue(false);

    const res = await sync();

    expect(res.status).toBe(403);
    expect(syncProjectToCoda).not.toHaveBeenCalled();
  });
});
