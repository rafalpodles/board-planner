import { describe, it, expect, vi } from "vitest";
import type mongoose from "mongoose";
import { copyLegacyField, finaliseLegacyField, LEGACY_COLLECTION, LEGACY_FIELD } from "./organisation-field-migration";
import { scopedModelNames } from "./organisation-migration";

function fakeDb({ uncopied = 0, legacyRows = [] as { _id: string }[], copiedRows = [] as string[] } = {}) {
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
    indexes: () => Promise.resolve([{ name: "_id_", key: { _id: 1 } }]),
    countDocuments: (filter: Record<string, unknown>) =>
      Promise.resolve(name === "organisations" ? Number(copiedRows.includes(String(filter._id))) : uncopied),
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

    const dry = fakeDb({ legacyRows: rows, copiedRows: ["a"] });
    expect((await copyLegacyField(dry.connection, { apply: false })).organisationRows).toBe(1);
    expect(dry.updateOne).not.toHaveBeenCalled();

    const wet = fakeDb({ legacyRows: rows, copiedRows: ["a"] });
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

  it("unsets the old field everywhere and leaves an index without it alone", async () => {
    const { connection, updateMany, dropIndex } = fakeDb();

    await finaliseLegacyField(connection, { apply: true });

    expect(updateMany).toHaveBeenCalledWith({ [LEGACY_FIELD]: { $exists: true } }, { $unset: { [LEGACY_FIELD]: "" } });
    expect(dropIndex).not.toHaveBeenCalled();
  });
});
