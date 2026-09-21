import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Model } from "mongoose";
import { SINGLETON_ID, upsertSingleton } from "./singleton";

const findOneAndUpdate = vi.fn();
const model = { findOneAndUpdate } as unknown as Model<{ aiModel: string }>;

const duplicate = (field: string) =>
  Object.assign(new Error("E11000"), { code: 11000, keyPattern: { [field]: 1 } });

beforeEach(() => findOneAndUpdate.mockReset());

describe("upsertSingleton", () => {
  it("matches whatever document exists, and inserts under the fixed id", async () => {
    findOneAndUpdate.mockResolvedValue({ aiModel: "m" });

    await upsertSingleton(model, { $set: { aiModel: "m" }, $setOnInsert: { other: 1 } });

    expect(findOneAndUpdate).toHaveBeenCalledWith(
      {},
      { $set: { aiModel: "m" }, $setOnInsert: { other: 1, _id: SINGLETON_ID } },
      { upsert: true, returnDocument: "after" }
    );
  });

  it("retries once when a simultaneous first write took the fixed id, and returns the winner", async () => {
    findOneAndUpdate
      .mockRejectedValueOnce(duplicate("_id"))
      .mockResolvedValueOnce({ aiModel: "winner" });

    await expect(upsertSingleton(model, { $set: { aiModel: "x" } })).resolves.toEqual({
      aiModel: "winner",
    });
    expect(findOneAndUpdate).toHaveBeenCalledTimes(2);
    expect(findOneAndUpdate.mock.calls[1]).toEqual(findOneAndUpdate.mock.calls[0]);
  });

  it("does not retry a collision on any other index", async () => {
    findOneAndUpdate.mockRejectedValueOnce(duplicate("email"));

    await expect(upsertSingleton(model, {})).rejects.toMatchObject({ code: 11000 });
    expect(findOneAndUpdate).toHaveBeenCalledTimes(1);
  });

  it("does not retry an error that is not a collision", async () => {
    findOneAndUpdate.mockRejectedValueOnce(new Error("connection reset"));

    await expect(upsertSingleton(model, {})).rejects.toThrow("connection reset");
    expect(findOneAndUpdate).toHaveBeenCalledTimes(1);
  });

  it("retries only once", async () => {
    findOneAndUpdate
      .mockRejectedValueOnce(duplicate("_id"))
      .mockRejectedValueOnce(duplicate("_id"))
      .mockResolvedValueOnce({ aiModel: "third" });

    await expect(upsertSingleton(model, {})).rejects.toMatchObject({ code: 11000 });
    expect(findOneAndUpdate).toHaveBeenCalledTimes(2);
  });
});
