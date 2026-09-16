import { describe, it, expect, vi, beforeEach } from "vitest";

const deleteMany = vi.fn();
const create = vi.fn();
const findOneAndUpdate = vi.fn();
const findOne = vi.fn();
const updateOne = vi.fn();

vi.mock("./db", () => ({ connectDB: vi.fn() }));
vi.mock("@/models/emailChangeToken", () => ({
  EmailChangeToken: { deleteMany, create, findOneAndUpdate, findOne, updateOne },
}));

const { issueEmailChange, consumeEmailChange, pendingEmailChange, cancelEmailChange } = await import("./email-change");
const { sha256 } = await import("./oauth");

beforeEach(() => {
  vi.clearAllMocks();
});

// BP-359
describe("email change links", () => {
  it("stores only a hash, and replaces any link still pending for the account", async () => {
    const token = await issueEmailChange("u1", "new@example.com");

    expect(token).toMatch(/^cpe_[0-9a-f]{64}$/);
    expect(deleteMany).toHaveBeenCalledWith({ user: "u1", usedAt: null });
    const stored = create.mock.calls[0][0];
    expect(stored).toMatchObject({ user: "u1", email: "new@example.com", tokenHash: sha256(token) });
    expect(JSON.stringify(stored)).not.toContain(token);
    expect(deleteMany.mock.invocationCallOrder[0]).toBeLessThan(create.mock.invocationCallOrder[0]);
  });

  it("gives a link a day", async () => {
    const before = Date.now();
    await issueEmailChange("u1", "new@example.com");

    const expiresAt: Date = create.mock.calls[0][0].expiresAt;
    expect(expiresAt.getTime() - before).toBeGreaterThanOrEqual(24 * 60 * 60 * 1000 - 1000);
    expect(expiresAt.getTime() - before).toBeLessThanOrEqual(24 * 60 * 60 * 1000 + 1000);
  });

  it("claims a link only while it is unused and unexpired, in one write", async () => {
    findOneAndUpdate.mockResolvedValue({ user: "u1", email: "new@example.com" });

    const outcome = await consumeEmailChange("cpe_x");

    expect(outcome).toEqual({ ok: true, userId: "u1", email: "new@example.com" });
    const [filter, update] = findOneAndUpdate.mock.calls[0];
    expect(filter).toEqual({ tokenHash: sha256("cpe_x"), usedAt: null, expiresAt: { $gt: expect.any(Date) } });
    expect(update).toEqual({ $set: { usedAt: expect.any(Date) } });
  });

  it("says why a link cannot be spent", async () => {
    findOneAndUpdate.mockResolvedValue(null);

    findOne.mockReturnValueOnce({ lean: async () => null });
    expect(await consumeEmailChange("cpe_x")).toEqual({ ok: false, reason: "unknown" });
    findOne.mockReturnValueOnce({ lean: async () => ({ usedAt: new Date() }) });
    expect(await consumeEmailChange("cpe_x")).toEqual({ ok: false, reason: "used" });
    findOne.mockReturnValueOnce({ lean: async () => ({ usedAt: null }) });
    expect(await consumeEmailChange("cpe_x")).toEqual({ ok: false, reason: "expired" });
  });

  it("reports only a pending link that can still be confirmed", async () => {
    findOne.mockReturnValue({ sort: () => ({ lean: async () => ({ email: "new@example.com", expiresAt: new Date(1) }) }) });

    expect(await pendingEmailChange("u1")).toEqual({ email: "new@example.com", expiresAt: new Date(1) });
    expect(findOne.mock.calls[0][0]).toEqual({ user: "u1", usedAt: null, expiresAt: { $gt: expect.any(Date) } });

    findOne.mockReturnValue({ sort: () => ({ lean: async () => null }) });
    expect(await pendingEmailChange("u1")).toBeNull();
  });

  it("cancels only links not yet spent", async () => {
    await cancelEmailChange("u1");

    expect(deleteMany).toHaveBeenCalledWith({ user: "u1", usedAt: null });
  });
});
