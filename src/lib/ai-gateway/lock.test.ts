import { describe, it, expect, vi, beforeEach } from "vitest";

const updateOne = vi.fn();
vi.mock("@/lib/db", () => ({ connectDB: vi.fn() }));
vi.mock("@/models/organisation", () => ({ Organisation: { updateOne } }));

const { setAiLocked } = await import("./lock");

const ID = "0123456789abcdef01234567";

beforeEach(() => {
  updateOne.mockReset().mockResolvedValue({ matchedCount: 1 });
});

// BP-680
describe("setAiLocked", () => {
  it("stamps the time and the reason on a live organisation, and says so", async () => {
    expect(await setAiLocked(ID, true, "abuse report 17")).toBe("ok");

    const [filter, update] = updateOne.mock.calls[0];
    expect(String(filter._id)).toBe(ID);
    expect(filter).toMatchObject({ deletedAt: null, deletingAt: null });
    expect(update.$set.aiLockedAt).toBeInstanceOf(Date);
    expect(update.$set.aiLockedReason).toBe("abuse report 17");
  });

  it("clears both when it switches the key back on", async () => {
    await setAiLocked(ID, false);

    expect(updateOne.mock.calls[0][1]).toEqual({ $set: { aiLockedAt: null, aiLockedReason: "" } });
  });

  it("reads an upper-case id the same, and refuses what is not an id without asking the database", async () => {
    await setAiLocked(ID.toUpperCase(), true);
    expect(String(updateOne.mock.calls[0][0]._id)).toBe(ID);

    updateOne.mockClear();
    expect(await setAiLocked("not-an-id", true)).toBe("not_found");
    expect(await setAiLocked(`${ID}0`, true)).toBe("not_found");
    expect(updateOne).not.toHaveBeenCalled();
  });

  it("refuses the default organisation, which is the operator's own, without writing", async () => {
    expect(await setAiLocked("000000000000000000000001", true)).toBe("default_organisation");
    expect(updateOne).not.toHaveBeenCalled();
  });

  it("says not found for an organisation that is gone or being deleted, which the filter does not match", async () => {
    updateOne.mockResolvedValue({ matchedCount: 0 });

    expect(await setAiLocked(ID, true)).toBe("not_found");
  });
});
