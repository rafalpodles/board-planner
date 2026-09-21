import { describe, it, expect, vi, beforeEach } from "vitest";

const { connectDB, findOneAndUpdate } = vi.hoisted(() => ({
  connectDB: vi.fn(),
  findOneAndUpdate: vi.fn(),
}));

vi.mock("./db", () => ({ connectDB }));
vi.mock("@/models/tenant", () => ({ Tenant: { findOneAndUpdate } }));

const { getTenant } = await import("./tenant");

beforeEach(() => {
  vi.clearAllMocks();
});

describe("getTenant", () => {
  it("upserts the singleton with the documented default on first read", async () => {
    findOneAndUpdate.mockResolvedValue({
      _id: "tenant-1",
      entitlements: { plan: "free", features: [], source: "none" },
    });

    const tenant = await getTenant();

    expect(connectDB).toHaveBeenCalled();
    expect(findOneAndUpdate).toHaveBeenCalledWith(
      {},
      { $setOnInsert: { entitlements: { plan: "free", features: [], source: "none" } } },
      { upsert: true, returnDocument: "after" }
    );
    expect(tenant.entitlements).toEqual({ plan: "free", features: [], source: "none" });
  });

  it("a second read resolves to the same document the upsert already created", async () => {
    // findOneAndUpdate with $setOnInsert is idempotent: once the singleton exists, every
    // further call matches the same {} filter and returns that document untouched.
    const existing = { _id: "tenant-1", entitlements: { plan: "pro", features: [], source: "service" } };
    findOneAndUpdate.mockResolvedValue(existing);

    const first = await getTenant();
    const second = await getTenant();

    expect(first._id).toBe("tenant-1");
    expect(second._id).toBe(first._id);
  });
});
