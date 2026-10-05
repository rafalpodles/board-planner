import { describe, it, expect, vi, beforeEach } from "vitest";
import { Types } from "mongoose";
import type { ScopedDb } from "@/lib/db-scope";

const { getSettings, updateSettings } = await import("./settings");

const findOneAndUpdate = vi.fn();
const db = { organisation: new Types.ObjectId(), Settings: { findOneAndUpdate } } as unknown as ScopedDb;
const duplicateOn = (field: string) => Object.assign(new Error("E11000"), { code: 11000, keyPattern: { [field]: 1 } });

beforeEach(() => findOneAndUpdate.mockReset().mockResolvedValue({ aiModel: "m" }));

describe("an organisation's settings row (BP-667)", () => {
  it("is upserted through the organisation's own db, so each organisation has one", async () => {
    await updateSettings(db, { $set: { aiModel: "m" } });

    expect(findOneAndUpdate).toHaveBeenCalledWith({}, { $set: { aiModel: "m" } }, { upsert: true, returnDocument: "after" });
  });

  it("is created by a first read with the default model", async () => {
    await getSettings(db);

    expect(findOneAndUpdate).toHaveBeenCalledWith({}, { $setOnInsert: { aiModel: "gpt-4o-mini" } }, { upsert: true, returnDocument: "after" });
  });

  it("retries once when a concurrent first write created the organisation's row", async () => {
    findOneAndUpdate.mockRejectedValueOnce(duplicateOn("organisation"));

    expect(await updateSettings(db, { $set: { aiModel: "m" } })).toEqual({ aiModel: "m" });
    expect(findOneAndUpdate).toHaveBeenCalledTimes(2);
  });

  it("does not retry any other failure", async () => {
    findOneAndUpdate.mockRejectedValueOnce(duplicateOn("_id"));

    await expect(updateSettings(db, { $set: { aiModel: "m" } })).rejects.toThrow("E11000");
    expect(findOneAndUpdate).toHaveBeenCalledTimes(1);
  });
});
