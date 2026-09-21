import { describe, it, expect, vi, beforeEach } from "vitest";

const { connectDB, findOneAndUpdate } = vi.hoisted(() => ({
  connectDB: vi.fn(),
  findOneAndUpdate: vi.fn(),
}));

vi.mock("./db", () => ({ connectDB }));
vi.mock("@/models/tenant", () => ({ Tenant: { findOneAndUpdate } }));

const { getTenant } = await import("./tenant");
const { SINGLETON_ID } = await import("./singleton");

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
      {
        $setOnInsert: {
          entitlements: { plan: "free", features: [], source: "none" },
          _id: SINGLETON_ID,
        },
      },
      { upsert: true, returnDocument: "after" }
    );
    expect(tenant.entitlements).toEqual({ plan: "free", features: [], source: "none" });
  });

  it("issues the exact same idempotent upsert on a second read, not a differently-shaped write", async () => {
    // What actually makes a second read safe is that every call sends the identical {} filter
    // and $setOnInsert — a mocked model returns whatever it's told to regardless of arguments,
    // so asserting only the resolved value here would pass even for a second call that switched
    // to Tenant.create() or changed the filter, either of which would create a second document
    // against a real Mongo.
    const existing = { _id: "tenant-1", entitlements: { plan: "pro", features: [], source: "service" } };
    findOneAndUpdate.mockResolvedValue(existing);

    await getTenant();
    await getTenant();

    expect(findOneAndUpdate).toHaveBeenCalledTimes(2);
    const [firstCall, secondCall] = findOneAndUpdate.mock.calls;
    expect(secondCall).toEqual(firstCall);
  });
});
