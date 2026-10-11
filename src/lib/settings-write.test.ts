import { describe, it, expect, vi } from "vitest";
import { writeSettings } from "./settings-write";

const dbWith = (findOneAndUpdate: ReturnType<typeof vi.fn>) => ({ Settings: { findOneAndUpdate } }) as never;
const duplicate = (field: string) => Object.assign(new Error("E11000"), { code: 11000, keyPattern: { [field]: 1 } });

describe("writing an organisation's settings", () => {
  it("upserts what it is given", async () => {
    const write = vi.fn().mockResolvedValue({});

    await writeSettings(dbWith(write), { $set: { "sso.label": "x" } });

    expect(write).toHaveBeenCalledWith({}, { $set: { "sso.label": "x" } }, { upsert: true });
  });

  it("tries once more when two first writes of the organisation's row raced on the unique index", async () => {
    const write = vi.fn().mockRejectedValueOnce(duplicate("organisation")).mockResolvedValueOnce({});

    await writeSettings(dbWith(write), { $addToSet: { disabledProviders: "google" } });

    expect(write).toHaveBeenCalledTimes(2);
  });

  it("does not hide any other failure, or a duplicate of anything else", async () => {
    await expect(writeSettings(dbWith(vi.fn().mockRejectedValue(new Error("down"))), { $set: {} })).rejects.toThrow("down");
    const write = vi.fn().mockRejectedValue(duplicate("something"));

    await expect(writeSettings(dbWith(write), { $set: {} })).rejects.toThrow("E11000");
    expect(write).toHaveBeenCalledTimes(1);
  });
});
