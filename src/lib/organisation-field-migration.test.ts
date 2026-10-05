import { describe, it, expect, vi } from "vitest";
import type mongoose from "mongoose";
import { copyLegacyField, finaliseLegacyField, LEGACY_COLLECTION, LEGACY_FIELD } from "./organisation-field-migration";
import { scopedModelNames } from "./organisation-migration";

function fakeDb({
  uncopied = 0,
  legacyRows = [] as Record<string, unknown>[],
  copiedRows = [] as Record<string, unknown>[],
  indexes = () => Promise.resolve([{ name: "_id_", key: { _id: 1 } }]) as Promise<unknown[]>,
} = {}) {
  const updateMany = vi.fn(() => Promise.resolve({ modifiedCount: 1 }));
  const updateOne = vi.fn();
  const dropIndex = vi.fn();
  const drop = vi.fn();
  const collection = (name: string) => ({
    collectionName: name,
    updateMany,
    updateOne,
    dropIndex,
    drop,
    indexes,
    countDocuments: () => Promise.resolve(uncopied),
    findOne: (filter: Record<string, unknown>) => Promise.resolve(copiedRows.find((row) => row._id === filter._id) ?? null),
    find: () => ({ toArray: () => Promise.resolve(name === LEGACY_COLLECTION ? legacyRows : []) }),
  });
  const db = { collection, listCollections: () => ({ toArray: () => Promise.resolve([]) }) };
  return { connection: { db } as unknown as mongoose.Connection, updateMany, updateOne, dropIndex, drop };
}

describe("copyLegacyField", () => {
  it("copies the old field into organisation with a pipeline, only where organisation is missing", async () => {
    const { connection, updateMany } = fakeDb();

    await copyLegacyField(connection, { apply: true });

    expect(updateMany).toHaveBeenCalledTimes(scopedModelNames().length);
    expect(updateMany).toHaveBeenCalledWith(
      { [LEGACY_FIELD]: { $exists: true }, organisation: { $exists: false } },
      [{ $set: { organisation: `$${LEGACY_FIELD}` } }]
    );
  });

  it("inserts an organisation row only when none has its id, and never in a dry run", async () => {
    const rows = [{ _id: "a", name: "A" }, { _id: "b", name: "B" }];

    const dry = fakeDb({ legacyRows: rows, copiedRows: [rows[0]] });
    expect((await copyLegacyField(dry.connection, { apply: false })).organisationRows).toBe(1);
    expect(dry.updateOne).not.toHaveBeenCalled();

    const wet = fakeDb({ legacyRows: rows, copiedRows: [rows[0]] });
    await copyLegacyField(wet.connection, { apply: true });
    expect(wet.updateOne).toHaveBeenCalledTimes(1);
    expect(wet.updateOne).toHaveBeenCalledWith({ _id: "b" }, { $setOnInsert: { name: "B" } }, { upsert: true });
  });
});

describe("finaliseLegacyField", () => {
  it("refuses, writing nothing, while any document is uncopied", async () => {
    const { connection, updateMany, dropIndex, drop } = fakeDb({ uncopied: 1 });

    await expect(finaliseLegacyField(connection, { apply: true })).rejects.toThrow(/run the copy again/);
    expect([updateMany, dropIndex, drop].map((fn) => fn.mock.calls.length)).toEqual([0, 0, 0]);
  });

  it("refuses while an organisation row is uncopied", async () => {
    const { connection, updateMany } = fakeDb({ legacyRows: [{ _id: "late" }] });


    await expect(finaliseLegacyField(connection, { apply: true })).rejects.toThrow(/late has not been copied/);
    expect(updateMany).not.toHaveBeenCalled();
  });

  it("refuses while an organisation differs from its old row, ignoring key order and the version key", async () => {
    const legacy = { _id: "o", name: "Acme", entitlements: { plan: "pro", features: [] }, __v: 0 };
    const same = fakeDb({ legacyRows: [legacy], copiedRows: [{ _id: "o", entitlements: { features: [], plan: "pro" }, name: "Acme", __v: 3, extra: 1 }] });
    await expect(finaliseLegacyField(same.connection, { apply: false })).resolves.toBeDefined();

    const renamed = fakeDb({ legacyRows: [legacy], copiedRows: [{ ...legacy, name: "Acme 2" }] });
    await expect(finaliseLegacyField(renamed.connection, { apply: true })).rejects.toThrow(/differs from its old row in name/);
    expect(renamed.updateMany).not.toHaveBeenCalled();
  });

  it("stops on a failure to read indexes rather than leaving an old index behind, and skips a missing collection", async () => {
    const failing = fakeDb({ indexes: () => Promise.reject(Object.assign(new Error("boom"), { code: 6 })) });
    await expect(finaliseLegacyField(failing.connection, { apply: true })).rejects.toThrow("boom");
    expect(failing.updateMany).not.toHaveBeenCalled();

    const missing = fakeDb({ indexes: () => Promise.reject(Object.assign(new Error("ns"), { code: 26, codeName: "NamespaceNotFound" })) });
    await expect(finaliseLegacyField(missing.connection, { apply: true })).resolves.toBeDefined();
  });

  it("unsets the old field everywhere and leaves an index without it alone", async () => {
    const { connection, updateMany, dropIndex } = fakeDb();

    await finaliseLegacyField(connection, { apply: true });

    expect(updateMany).toHaveBeenCalledWith({ [LEGACY_FIELD]: { $exists: true } }, { $unset: { [LEGACY_FIELD]: "" } });
    expect(dropIndex).not.toHaveBeenCalled();
  });
});
