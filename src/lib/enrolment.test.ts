import { describe, it, expect, vi, beforeEach } from "vitest";
import bcrypt from "bcryptjs";
import { Types } from "mongoose";

const find = vi.fn();
const create = vi.fn();
const findOneAndUpdate = vi.fn();
const findByIdAndUpdate = vi.fn();
const findById = vi.fn();

vi.mock("./db", () => ({ connectDB: vi.fn() }));
vi.mock("@/models/enrolmentToken", () => ({
  EnrolmentToken: { find, create, findOneAndUpdate, findByIdAndUpdate, findById },
}));

const { mintEnrolmentToken, consumeEnrolmentToken, enrolmentTokenOwnerId, ENROLMENT_TTL_MS } =
  await import("./enrolment");

const now = new Date("2026-08-03T12:00:00.000Z");

async function row(token: string, overrides: Record<string, unknown> = {}) {
  return {
    _id: "e1",
    prefix: token.substring(0, 12),
    tokenHash: await bcrypt.hash(token, 4),
    expiresAt: new Date(now.getTime() + ENROLMENT_TTL_MS),
    usedAt: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  create.mockResolvedValue({});
  find.mockResolvedValue([]);
  findOneAndUpdate.mockImplementation((filter) =>
    Promise.resolve(filter.usedAt === null ? { _id: "e1" } : null)
  );
});

describe("mintEnrolmentToken", () => {
  it("issues a recognisable token and never stores it in the clear", async () => {
    const { token } = await mintEnrolmentToken("admin-1", "rig laptop", now);

    expect(token.startsWith("cpe_")).toBe(true);
    const stored = create.mock.calls[0][0];
    expect(stored.tokenHash).not.toContain(token);
    expect(await bcrypt.compare(token, stored.tokenHash)).toBe(true);
  });

  it("expires an hour out, so a token left in a chat log stops working", async () => {
    const { expiresAt } = await mintEnrolmentToken("admin-1", "", now);

    expect(expiresAt.getTime() - now.getTime()).toBe(ENROLMENT_TTL_MS);
  });

  it("stores it unused and unattached", async () => {
    await mintEnrolmentToken("admin-1", "", now);

    expect(create.mock.calls[0][0]).toMatchObject({ usedAt: null, usedByWorker: null });
  });
});

describe("consumeEnrolmentToken", () => {
  it("spends a valid token exactly once", async () => {
    const token = "cpe_" + "a".repeat(48);
    find.mockResolvedValue([await row(token)]);

    const result = await consumeEnrolmentToken(token, now);

    expect(result).toEqual({ ok: true, tokenId: "e1" });
    expect(findOneAndUpdate).toHaveBeenCalledWith(
      { _id: "e1", usedAt: null },
      { $set: { usedAt: now } },
      { new: true }
    );
  });

  it("refuses a token another worker already spent", async () => {
    const token = "cpe_" + "b".repeat(48);
    find.mockResolvedValue([await row(token)]);
    findOneAndUpdate.mockResolvedValue(null);

    expect(await consumeEnrolmentToken(token, now)).toEqual({ ok: false, reason: "used" });
  });

  it("refuses an expired token without spending it", async () => {
    const token = "cpe_" + "c".repeat(48);
    find.mockResolvedValue([
      await row(token, { expiresAt: new Date(now.getTime() - 1) }),
    ]);

    expect(await consumeEnrolmentToken(token, now)).toEqual({ ok: false, reason: "expired" });
    expect(findOneAndUpdate).not.toHaveBeenCalled();
  });

  it("treats a token expiring exactly now as expired", async () => {
    const token = "cpe_" + "d".repeat(48);
    find.mockResolvedValue([await row(token, { expiresAt: new Date(now.getTime()) })]);

    expect(await consumeEnrolmentToken(token, now)).toEqual({ ok: false, reason: "expired" });
  });

  it("refuses a string that was never issued", async () => {
    find.mockResolvedValue([]);

    expect(await consumeEnrolmentToken("cpe_" + "e".repeat(48), now)).toEqual({
      ok: false,
      reason: "unknown",
    });
  });

  it("refuses a token whose hash does not match a same-prefix row", async () => {
    const issued = "cpe_" + "f".repeat(48);
    const guessed = "cpe_" + "f".repeat(47) + "0";
    find.mockResolvedValue([await row(issued)]);

    expect(await consumeEnrolmentToken(guessed, now)).toEqual({ ok: false, reason: "unknown" });
    expect(findOneAndUpdate).not.toHaveBeenCalled();
  });

  it("refuses anything not shaped like an enrolment token without touching the database", async () => {
    expect(await consumeEnrolmentToken("cp_an_api_token", now)).toEqual({
      ok: false,
      reason: "unknown",
    });
    expect(await consumeEnrolmentToken("", now)).toEqual({ ok: false, reason: "unknown" });
    expect(find).not.toHaveBeenCalled();
  });
});

describe("enrolmentTokenOwnerId", () => {
  it("returns the token creator's id as a string", async () => {
    const createdBy = new Types.ObjectId("6a732075133f935b19154cd2");
    const select = vi.fn().mockReturnValue({ lean: () => Promise.resolve({ createdBy }) });
    findById.mockReturnValue({ select });

    expect(await enrolmentTokenOwnerId("e1")).toBe("6a732075133f935b19154cd2");
    expect(findById).toHaveBeenCalledWith("e1");
    expect(select).toHaveBeenCalledWith("createdBy");
  });

  it("returns null when the token cannot be found", async () => {
    findById.mockReturnValue({ select: () => ({ lean: () => Promise.resolve(null) }) });

    expect(await enrolmentTokenOwnerId("missing")).toBeNull();
  });
});
