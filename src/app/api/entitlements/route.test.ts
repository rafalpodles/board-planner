import { describe, it, expect, vi, beforeEach } from "vitest";

const { getAuthUser, getTenant } = vi.hoisted(() => ({
  getAuthUser: vi.fn(),
  getTenant: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({ getAuthUser }));
vi.mock("@/lib/db", () => ({ connectDB: vi.fn() }));
vi.mock("@/lib/tenant", () => ({ getTenant }));

const { GET } = await import("./route");

function get() {
  return GET(new Request("http://localhost/api/entitlements"), { params: Promise.resolve({}) });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("GET /api/entitlements", () => {
  it("401s without credentials", async () => {
    getAuthUser.mockResolvedValue(null);

    const res = await get();

    expect(res.status).toBe(401);
    expect(getTenant).not.toHaveBeenCalled();
  });

  it("answers the tenant's plan, features and expiry for any authenticated user", async () => {
    getAuthUser.mockResolvedValue({ _id: "u1", username: "member", role: "member" });
    getTenant.mockResolvedValue({
      entitlements: { plan: "pro", features: ["integrations.coda"], expiresAt: undefined },
    });

    const res = await get();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ plan: "pro", features: ["integrations.coda"], expiresAt: null });
  });
});
