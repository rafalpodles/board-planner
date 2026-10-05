import { describe, it, expect, vi, beforeEach } from "vitest";

const { getAuthUser, getOrganisation } = vi.hoisted(() => ({
  getAuthUser: vi.fn(),
  getOrganisation: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({ getAuthUser }));
vi.mock("@/lib/db", () => ({ connectDB: vi.fn() }));
vi.mock("@/lib/organisation", () => ({ getOrganisation }));

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
    expect(getOrganisation).not.toHaveBeenCalled();
  });

  it("answers the organisation's plan, features and expiry for any authenticated user", async () => {
    getAuthUser.mockResolvedValue({ _id: "u1", username: "member", role: "member" });
    getOrganisation.mockResolvedValue({
      name: "Acme",
      entitlements: { plan: "pro", features: ["integrations.coda"], expiresAt: undefined },
    });

    const res = await get();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ organisation: "Acme", plan: "pro", features: ["integrations.coda"], expiresAt: null });
  });

  it("calls an organisation that was never named the default one", async () => {
    getAuthUser.mockResolvedValue({ _id: "u1", username: "member", role: "member" });
    getOrganisation.mockResolvedValue({ entitlements: { plan: "free", features: [] } });

    expect(await (await get()).json()).toMatchObject({ organisation: "default" });
  });
});
