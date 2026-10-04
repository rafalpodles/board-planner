import { describe, it, expect, vi, beforeEach } from "vitest";

const countDocuments = vi.fn();

vi.mock("@/lib/db", () => ({ connectDB: vi.fn() }));
vi.mock("@/models/user", () => ({ User: { countDocuments } }));
vi.mock("@/lib/tenant-host", async (importOriginal) => {
  const { DEFAULT_TENANT_ID } = await import("@/lib/tenant-field");
  return {
    ...(await importOriginal<typeof import("@/lib/tenant-host")>()),
    tenantOfRequest: async () => ({ kind: "tenant", tenant: DEFAULT_TENANT_ID }),
  };
});

const { GET } = await import("./route");

beforeEach(() => vi.clearAllMocks());

/**
 * BP-268. The page used to offer account creation unconditionally; this is the fact it was
 * missing. It decides what is offered, never what is allowed — POST /api/users counts the users
 * itself and refuses a second bootstrap whatever any client believes.
 */
describe("GET /api/auth/instance", () => {
  it("offers no first account when organisations live on subdomains (BP-666)", async () => {
    process.env.TENANT_DOMAIN = "board-planner.com";
    try {
      countDocuments.mockResolvedValue(0);
      const res = await GET(new Request("http://localhost/api/auth/instance"));
      expect(res.status).toBe(200);
      expect((await res.json()).unclaimed).toBe(false);
    } finally {
      delete process.env.TENANT_DOMAIN;
    }
  });

  it("says an empty instance is unclaimed", async () => {
    countDocuments.mockResolvedValue(0);

    expect(await (await GET(new Request("http://localhost/api/auth/instance"))).json()).toEqual({ unclaimed: true, passwordSignIn: true });
  });

  // The control, and the half the bug was on: without it "answers unclaimed" and "answers the
  // same thing whatever the database holds" are indistinguishable
  it("says an instance with one user is not", async () => {
    countDocuments.mockResolvedValue(1);

    expect(await (await GET(new Request("http://localhost/api/auth/instance"))).json()).toEqual({ unclaimed: false, passwordSignIn: true });
  });

  it("says when the operator turned password sign-in off", async () => {
    countDocuments.mockResolvedValue(1);
    process.env.PASSWORD_SIGN_IN = "off";

    try {
      expect((await (await GET(new Request("http://localhost/api/auth/instance"))).json()).passwordSignIn).toBe(false);
    } finally {
      delete process.env.PASSWORD_SIGN_IN;
    }
  });

  // Unreachable is not unclaimed: the page would offer to create an administrator on an instance
  // that may already have one
  it("refuses to answer at all when the database cannot be read", async () => {
    countDocuments.mockRejectedValue(
      Object.assign(new Error("connect ECONNREFUSED"), { name: "MongooseServerSelectionError" })
    );

    process.env.PASSWORD_SIGN_IN = "off";
    const res = await GET(new Request("http://localhost/api/auth/instance"));
    delete process.env.PASSWORD_SIGN_IN;

    expect(res.status).toBe(503);
    // Read from the environment: an off instance must not fall back to its password form
    expect((await res.clone().json()).passwordSignIn).toBe(false);
    expect(await res.json()).not.toMatchObject({ unclaimed: true });
  });
});
