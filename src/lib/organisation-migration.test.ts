import { describe, it, expect, vi } from "vitest";
import type mongoose from "mongoose";
import { DEFAULT_ORGANISATION_ID } from "./organisation-field";
import { backfillOrganisations, ensureOrganisation, scopedModelNames, UNSCOPED_MODELS } from "./organisation-migration";

function fakeDb(missing: number, organisationRows: Record<string, unknown>[] = []) {
  const calls = { updateMany: vi.fn(() => Promise.resolve({ matchedCount: missing })), insertOne: vi.fn(), deleteOne: vi.fn(), updateOne: vi.fn() };
  const touched: string[] = [];
  const collection = (name: string) => {
    touched.push(name);
    return {
      collectionName: name,
      countDocuments: () => Promise.resolve(missing),
      find: () => ({ toArray: () => Promise.resolve(organisationRows) }),
      ...calls,
    };
  };
  return { connection: { db: { collection } } as unknown as mongoose.Connection, calls, touched };
}

describe("backfillOrganisations", () => {
  it("gives every scoped collection the default organisation where it has none, and counts what it gave", async () => {
    const { connection, calls } = fakeDb(2);

    const { total } = await backfillOrganisations(connection, { apply: true });

    expect(calls.updateMany).toHaveBeenCalledTimes(scopedModelNames().length);
    expect(calls.updateMany).toHaveBeenCalledWith({ organisation: null }, { $set: { organisation: DEFAULT_ORGANISATION_ID } });
    expect(total).toBe(2 * scopedModelNames().length);
  });

  it("touches neither the organisation table nor the throttle", async () => {
    const { connection, touched } = fakeDb(1);

    await backfillOrganisations(connection, { apply: true });

    expect(touched).not.toContain("organisations");
    expect(touched).not.toContain("ratelimits");
    expect(UNSCOPED_MODELS).toEqual(["Organisation", "RateLimit"]);
  });

  it("only counts in a dry run", async () => {
    const { connection, calls } = fakeDb(3);

    const { total } = await backfillOrganisations(connection, { apply: false });

    expect(calls.updateMany).not.toHaveBeenCalled();
    expect(total).toBe(3 * scopedModelNames().length);
  });

  it("refuses a connection that has no database", async () => {
    await expect(backfillOrganisations({} as mongoose.Connection, { apply: false })).rejects.toThrow("No database handle");
  });
});

describe("ensureOrganisation", () => {
  const legacy = { _id: "legacy-id", entitlements: { plan: "pro", features: [], source: "service" } };

  it("re-keys the legacy row to the default id, names it and keeps its entitlements", async () => {
    const { connection, calls } = fakeDb(0, [legacy]);

    expect(await ensureOrganisation(connection, { apply: true, name: "Rafał-org" })).toBe("re-keyed");

    expect(calls.insertOne).toHaveBeenCalledWith(
      expect.objectContaining({ _id: DEFAULT_ORGANISATION_ID, name: "Rafał-org", entitlements: legacy.entitlements })
    );
    expect(calls.deleteOne).toHaveBeenCalledWith({ _id: "legacy-id" });
  });

  it("creates the organisation when the instance has no organisation row", async () => {
    const { connection, calls } = fakeDb(0, []);

    expect(await ensureOrganisation(connection, { apply: true, name: "Acme" })).toBe("created");

    expect(calls.insertOne).toHaveBeenCalledWith(expect.objectContaining({ _id: DEFAULT_ORGANISATION_ID, name: "Acme" }));
    expect(calls.deleteOne).not.toHaveBeenCalled();
  });

  it("only renames an organisation that already has the default id", async () => {
    const { connection, calls } = fakeDb(0, [{ _id: DEFAULT_ORGANISATION_ID }]);

    expect(await ensureOrganisation(connection, { apply: true, name: "New name" })).toBe("present");

    expect(calls.updateOne).toHaveBeenCalledWith({ _id: DEFAULT_ORGANISATION_ID }, { $set: { name: "New name" } });
    expect(calls.insertOne).not.toHaveBeenCalled();
  });

  it("writes nothing in a dry run", async () => {
    const { connection, calls } = fakeDb(0, [legacy]);

    expect(await ensureOrganisation(connection, { apply: false, name: "X" })).toBe("re-keyed");

    expect(calls.insertOne).not.toHaveBeenCalled();
    expect(calls.deleteOne).not.toHaveBeenCalled();
    expect(calls.updateOne).not.toHaveBeenCalled();
  });

  it("refuses to guess between several organisation rows", async () => {
    const { connection } = fakeDb(0, [legacy, { _id: "other" }]);

    await expect(ensureOrganisation(connection, { apply: true, name: "X" })).rejects.toThrow(/cannot tell which is the organisation/);
  });
});
