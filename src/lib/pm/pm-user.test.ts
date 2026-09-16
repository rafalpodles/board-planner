import { describe, it, expect, vi, beforeEach } from "vitest";

const { findOne, findOneAndUpdate } = vi.hoisted(() => ({
  findOne: vi.fn(),
  findOneAndUpdate: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ connectDB: vi.fn() }));
vi.mock("@/models/user", () => ({ User: { findOne, findOneAndUpdate } }));

const { getPmUser } = await import("./pm-user");

beforeEach(() => {
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
    const stored = { username: "pm", kind: "human", save: vi.fn() };
    stored.save.mockImplementation(async () => stored);
    findOne.mockResolvedValue(stored);

    const pm = await getPmUser();

    expect(stored.save).toHaveBeenCalledTimes(1);
    expect(pm.kind).toBe("machine");
    expect(findOneAndUpdate).not.toHaveBeenCalled();
  });

  it("writes nothing when the account is already a machine", async () => {
    const stored = { username: "pm", kind: "machine", save: vi.fn() };
    findOne.mockResolvedValue(stored);

    expect(await getPmUser()).toBe(stored);
    expect(stored.save).not.toHaveBeenCalled();
  });
});
