import { describe, it, expect, vi, beforeEach } from "vitest";
import { scopedToDefaultTenant } from "@/lib/db-scope";
import { DEFAULT_TENANT_ID } from "@/lib/tenant-field";

const identityFind = vi.fn();
let caller: Record<string, unknown>;

vi.mock("@/lib/db", () => ({ connectDB: vi.fn() }));
vi.mock("@/lib/middleware", () => ({
  withAuth: (handler: (r: Request, c: unknown) => unknown) => (request: Request) =>
    handler(request, { user: caller, db: scopedToDefaultTenant() }),
}));
vi.mock("@/lib/oidc/providers", () => ({
  providerById: () => ({ label: "Acme" }),
  liveIdentityFilter: () => ({ live: "only" }),
}));
vi.mock("@/lib/password-sign-in", () => ({ passwordSignInEnabled: () => true }));
vi.mock("@/models/identity", () => ({
  Identity: {
    find: (filter: unknown) => {
      identityFind(filter);
      return { sort: () => ({ lean: async () => [] }) };
    },
  },
}));
vi.mock("@/models/user", () => ({ User: { findOne: () => ({ select: () => ({ lean: async () => ({}) }) }) } }));

const { GET } = await import("./route");

beforeEach(() => {
  vi.clearAllMocks();
  caller = { _id: "u1", username: "ada" };
});

describe("GET /api/users/me/identities", () => {
  // BP-842. A link from a provider's former issuer would hide Link and look like a way in
  it("lists only the links a configured provider still signs in through", async () => {
    const res = await GET(new Request("http://x/api/users/me/identities"), { params: Promise.resolve({}) });

    expect(res.status).toBe(200);
    expect(identityFind).toHaveBeenCalledWith({ user: "u1", live: "only", tenant: DEFAULT_TENANT_ID });
  });
});
