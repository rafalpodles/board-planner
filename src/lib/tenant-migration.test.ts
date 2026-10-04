import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type mongoose from "mongoose";
import { DEFAULT_TENANT_ID } from "./tenant-field";
import { backfillTenants, scopedModelNames, startTenantBackfill, UNSCOPED_MODELS } from "./tenant-migration";

function fakeConnection(missing: number) {
  const updateMany = vi.fn(() => Promise.resolve({ matchedCount: missing }));
  const countDocuments = vi.fn(() => Promise.resolve(missing));
  const collection = vi.fn((name: string) => ({ collectionName: name, updateMany, countDocuments }));
  return { connection: { db: { collection } } as unknown as mongoose.Connection, collection, updateMany, countDocuments };
}

describe("backfillTenants", () => {
  it("gives every scoped collection the default tenant where it has none, and counts what it gave", async () => {
    const { connection, updateMany } = fakeConnection(2);

    const { total, byCollection } = await backfillTenants(connection, { apply: true });

    expect(updateMany).toHaveBeenCalledTimes(scopedModelNames().length);
    expect(updateMany).toHaveBeenCalledWith({ tenant: null }, { $set: { tenant: DEFAULT_TENANT_ID } });
    expect(total).toBe(2 * scopedModelNames().length);
    expect(Object.keys(byCollection)).toHaveLength(scopedModelNames().length);
  });

  it("touches neither the tenant table nor the throttle", async () => {
    const { connection, collection } = fakeConnection(1);

    await backfillTenants(connection, { apply: true });

    const touched = collection.mock.calls.map(([name]) => name);
    expect(touched).not.toContain("tenants");
    expect(touched).not.toContain("ratelimits");
    expect(UNSCOPED_MODELS).toEqual(["Tenant", "RateLimit"]);
  });

  it("only counts in a dry run", async () => {
    const { connection, updateMany, countDocuments } = fakeConnection(3);

    const { total } = await backfillTenants(connection, { apply: false });

    expect(updateMany).not.toHaveBeenCalled();
    expect(countDocuments).toHaveBeenCalledWith({ tenant: null });
    expect(total).toBe(3 * scopedModelNames().length);
  });

  it("refuses a connection that has no database", async () => {
    await expect(backfillTenants({} as mongoose.Connection, { apply: false })).rejects.toThrow("No database handle");
  });
});

describe("startTenantBackfill", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("runs at once, says how many documents it gave, and runs again five minutes later", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const { connection, updateMany } = fakeConnection(1);

    startTenantBackfill(connection);
    await vi.advanceTimersByTimeAsync(0);
    const first = updateMany.mock.calls.length;
    expect(first).toBe(scopedModelNames().length);
    expect(log).toHaveBeenCalledWith(`Gave ${scopedModelNames().length} document(s) the default tenant`);

    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(updateMany.mock.calls.length).toBe(2 * first);
  });

  it("logs a failure and does not throw, so the app goes on starting", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    startTenantBackfill({ db: undefined } as unknown as mongoose.Connection);
    await vi.advanceTimersByTimeAsync(0);

    expect(error).toHaveBeenCalledWith("Failed to give every document a tenant:", expect.any(Error));
  });

  it("says nothing when there was nothing to give", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    startTenantBackfill(fakeConnection(0).connection);
    await vi.advanceTimersByTimeAsync(0);

    expect(log).not.toHaveBeenCalled();
  });
});
