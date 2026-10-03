import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { generateKeyPairSync } from "node:crypto";

const { connectDB, findOneAndUpdate } = vi.hoisted(() => ({
  connectDB: vi.fn(),
  findOneAndUpdate: vi.fn(),
}));

vi.mock("./db", () => ({ connectDB }));
vi.mock("@/models/tenant", () => ({ Tenant: { findOneAndUpdate } }));

const { getTenant } = await import("./tenant");
const { SINGLETON_ID } = await import("./singleton");
const { signLicence } = await import("./licence");

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
      { _id: SINGLETON_ID },
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

describe("getTenant with LICENCE_KEY", () => {
  const ORIGINAL = { ...process.env };
  const jwk = generateKeyPairSync("ed25519").privateKey.export({ format: "jwk" });
  const signing = { keyId: "e2e", d: jwk.d!, x: jwk.x! };
  const stored = { _id: "tenant-1", entitlements: { plan: "free", features: [], source: "none" } };

  function key(expiresAt: Date, customer = "Acme Ltd") {
    return signLicence(
      { customer, plan: "pro", features: [], issuedAt: new Date().toISOString(), expiresAt: expiresAt.toISOString() },
      signing
    );
  }

  beforeEach(() => {
    // The suite's own key, accepted outside a production build — the same door e2e uses
    process.env.E2E = "1";
    process.env.E2E_LICENCE_PUBLIC_KEY = signing.x;
    findOneAndUpdate.mockResolvedValue(stored);
  });

  afterEach(() => {
    process.env = { ...ORIGINAL };
  });

  it("derives pro from a valid key without writing it to the stored tenant", async () => {
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    process.env.LICENCE_KEY = key(expiresAt);

    const tenant = await getTenant();

    expect(tenant.entitlements).toMatchObject({ plan: "pro", customer: "Acme Ltd", expiresAt, source: "env" });
    expect(tenant._id).toBe("tenant-1");
    expect(findOneAndUpdate.mock.calls[0][1]).toEqual({
      $setOnInsert: expect.objectContaining({ entitlements: { plan: "free", features: [], source: "none" } }),
    });
  });

  it("reports free for a key past its grace period", async () => {
    process.env.LICENCE_KEY = key(new Date(Date.now() - 15 * 24 * 60 * 60 * 1000));

    expect((await getTenant()).entitlements).toEqual({ plan: "free", features: [], source: "env" });
  });

  it("leaves the stored entitlements for a key that does not verify", async () => {
    process.env.LICENCE_KEY = "garbage";

    expect(await getTenant()).toBe(stored);
  });
});
