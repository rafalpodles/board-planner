import { describe, it, expect, vi, beforeEach } from "vitest";

const { findOne, findOneAndUpdate, updateOne } = vi.hoisted(() => ({
  findOne: vi.fn(),
  findOneAndUpdate: vi.fn(),
  updateOne: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ connectDB: vi.fn() }));
vi.mock("@/models/user", () => ({ User: { findOne, findOneAndUpdate, updateOne } }));
const revokeUserCredentials = vi.fn();
vi.mock("@/lib/session", () => ({ revokeUserCredentials }));

const { getPmUser, markPmAsMachine } = await import("./pm-user");

beforeEach(() => {
  updateOne.mockReset();
  revokeUserCredentials.mockReset();
  findOne.mockReset();
  findOneAndUpdate.mockReset();
});

// BP-348: stored as a person, it was listed in Settings → Users and could be handed a password
describe("getPmUser", () => {
  it("creates the account as a machine identity, the way a worker's is", async () => {
    findOne.mockResolvedValue(null);
    findOneAndUpdate.mockImplementation(async (_filter, update) => update.$setOnInsert);

    const pm = await getPmUser();

    expect(findOneAndUpdate.mock.calls[0][1].$setOnInsert.kind).toBe("machine");
    expect(pm.kind).toBe("machine");
  });

  it("corrects an account an older release stored as a person", async () => {
    const stored = { _id: "pm-1", username: "pm", kind: "human", save: vi.fn() };
    stored.save.mockImplementation(async () => stored);
    findOne.mockResolvedValue(stored);

    const pm = await getPmUser();

    expect(stored.save).toHaveBeenCalledTimes(1);
    expect(pm.kind).toBe("machine");
    expect(findOneAndUpdate).not.toHaveBeenCalled();
    // A password somebody handed it must not survive as a way in
    expect(revokeUserCredentials).toHaveBeenCalledWith("pm-1");
  });

  it("writes nothing when the account is already a machine", async () => {
    const stored = { username: "pm", kind: "machine", save: vi.fn() };
    findOne.mockResolvedValue(stored);

    expect(await getPmUser()).toBe(stored);
    expect(stored.save).not.toHaveBeenCalled();
  });
});

// The boot-time half: an instance upgraded from a release that stored pm as a person
describe("markPmAsMachine", () => {
  it("flips a pm stored as a person, revokes what it held, and says so", async () => {
    findOne.mockResolvedValue({ _id: "pm-1", username: "pm", kind: "human", role: "admin", email: "" });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await markPmAsMachine();

    expect(findOne).toHaveBeenCalledWith({ username: "pm", kind: { $ne: "machine" } });
    expect(updateOne).toHaveBeenCalledWith({ _id: "pm-1" }, { $set: { kind: "machine" } });
    expect(revokeUserCredentials).toHaveBeenCalledWith("pm-1");
    expect(warn.mock.calls[0][0]).toContain("role admin");
    warn.mockRestore();
  });

  it("does nothing on an instance where pm is already a machine or absent", async () => {
    findOne.mockResolvedValue(null);

    await markPmAsMachine();

    expect(updateOne).not.toHaveBeenCalled();
    expect(revokeUserCredentials).not.toHaveBeenCalled();
  });
});
