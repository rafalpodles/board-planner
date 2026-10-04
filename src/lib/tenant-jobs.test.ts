import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Types } from "mongoose";

const find = vi.hoisted(() => vi.fn());
vi.mock("./db", () => ({ connectDB: vi.fn() }));
vi.mock("@/models/tenant", () => ({ Tenant: { find } }));

const { servedTenants, forEachServedTenant } = await import("./tenant-jobs");
const { DEFAULT_TENANT_ID } = await import("./tenant-field");

const A = new Types.ObjectId("0000000000000000000000a1");
const B = new Types.ObjectId("0000000000000000000000b2");
const rows = (list: unknown[]) => ({ select: () => ({ lean: async () => list }) });

beforeEach(() => find.mockReset());
afterEach(() => {
  delete process.env.TENANT_DOMAIN;
});

describe("the tenants background work serves (BP-667)", () => {
  it("is the default tenant alone on a single-tenant instance, even before its row exists", async () => {
    find.mockReturnValue(rows([]));
    expect(await servedTenants()).toEqual([{ _id: DEFAULT_TENANT_ID }]);
    expect(find).toHaveBeenCalledWith({ _id: DEFAULT_TENANT_ID });
  });

  it("is every tenant, with its own clock, when organisations live on subdomains", async () => {
    process.env.TENANT_DOMAIN = "board-planner.com";
    find.mockReturnValue(rows([{ _id: A, timezone: "Asia/Tokyo" }, { _id: B }]));

    expect(await servedTenants()).toEqual([{ _id: A, timezone: "Asia/Tokyo" }, { _id: B }]);
    expect(find).toHaveBeenCalledWith({});
  });

  it("hands each tenant its own db, and one tenant's failure does not stop the next", async () => {
    process.env.TENANT_DOMAIN = "board-planner.com";
    find.mockReturnValue(rows([{ _id: A }, { _id: B }]));
    vi.spyOn(console, "error").mockImplementation(() => {});
    const seen: string[] = [];

    await forEachServedTenant("test job", async (db) => {
      seen.push(db.tenant.toHexString());
      if (db.tenant.equals(A)) throw new Error("A broke");
    });

    expect(seen).toEqual([A.toHexString(), B.toHexString()]);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining(`test job failed for tenant ${A.toHexString()}`), expect.any(Error));
  });
});
