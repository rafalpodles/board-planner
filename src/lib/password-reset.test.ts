import { describe, it, expect, vi, beforeEach } from "vitest";
import { createHash } from "crypto";

const create = vi.fn();
const deleteMany = vi.fn();
const findOneAndUpdate = vi.fn();
const findOne = vi.fn();

vi.mock("@/lib/db", () => ({ connectDB: vi.fn() }));
vi.mock("@/models/passwordResetToken", () => ({
  PasswordResetToken: { create, deleteMany, findOneAndUpdate, findOne },
}));

const { issueResetToken, consumeResetToken, invalidateResetTokens, RESET_TOKEN_PREFIX } =
  await import("./password-reset");

const sha256 = (v: string) => createHash("sha256").update(v).digest("hex");

beforeEach(() => {
  vi.clearAllMocks();
  create.mockResolvedValue({});
  deleteMany.mockResolvedValue({});
  findOne.mockReturnValue({ lean: () => Promise.resolve(null) });
});

describe("issuing a link", () => {
  it("stores the hash and hands back the only copy of the token", async () => {
    const token = await issueResetToken("u1");

    expect(token.startsWith(RESET_TOKEN_PREFIX)).toBe(true);
    const stored = create.mock.calls[0][0];
    expect(stored.tokenHash).toBe(sha256(token));
    expect(JSON.stringify(stored)).not.toContain(token);
  });

  it("expires within the hour", async () => {
    const before = Date.now();
    await issueResetToken("u1");

    const { expiresAt } = create.mock.calls[0][0];
    expect(expiresAt.getTime()).toBeGreaterThan(before);
    expect(expiresAt.getTime()).toBeLessThanOrEqual(before + 60 * 60 * 1000 + 50);
  });

  it("kills any link already outstanding for that account", async () => {
    await issueResetToken("u1");

    expect(deleteMany).toHaveBeenCalledWith({ user: "u1", usedAt: null });
  });

  it("never issues the same token twice", async () => {
    const tokens = new Set<string>();
    for (let i = 0; i < 50; i++) tokens.add(await issueResetToken("u1"));

    expect(tokens.size).toBe(50);
  });
});

describe("spending a link", () => {
  it("claims and marks it in one update, matching on it being unspent", async () => {
    findOneAndUpdate.mockResolvedValue({ user: "u1" });

    const outcome = await consumeResetToken("cpr_abc");

    expect(outcome).toEqual({ ok: true, userId: "u1" });
    const [filter, update] = findOneAndUpdate.mock.calls[0];
    expect(filter.tokenHash).toBe(sha256("cpr_abc"));
    expect(filter.usedAt).toBeNull();
    expect(filter.expiresAt.$gt).toBeInstanceOf(Date);
    expect(update.$set.usedAt).toBeInstanceOf(Date);
  });

  it("looks the token up by hash, never by its raw value", async () => {
    findOneAndUpdate.mockResolvedValue(null);

    await consumeResetToken("cpr_abc");

    expect(JSON.stringify(findOneAndUpdate.mock.calls[0][0])).not.toContain("cpr_abc");
  });

  it.each([
    ["a token that never existed", null, "unknown"],
    ["one already spent", { usedAt: new Date() }, "used"],
    ["one whose hour has passed", { usedAt: null }, "expired"],
  ])("tells %s apart", async (_case, existing, reason) => {
    findOneAndUpdate.mockResolvedValue(null);
    findOne.mockReturnValue({ lean: () => Promise.resolve(existing) });

    expect(await consumeResetToken("cpr_abc")).toEqual({ ok: false, reason });
  });
});

describe("invalidating", () => {
  it("drops the links that could still be spent, and leaves the spent one behind", async () => {
    await invalidateResetTokens("u1");

    expect(deleteMany).toHaveBeenCalledWith({ user: "u1", usedAt: null });
  });
});
