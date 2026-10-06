import { describe, it, expect, vi, beforeEach } from "vitest";
import { Types } from "mongoose";

const { create, findOneAndUpdate, updateOne, findOne } = vi.hoisted(() => ({
  create: vi.fn(),
  findOneAndUpdate: vi.fn(),
  updateOne: vi.fn(),
  findOne: vi.fn(),
}));

vi.mock("./db", () => ({ connectDB: vi.fn() }));
vi.mock("@/models/platformSignIn", () => ({ PlatformSignIn: { create, findOneAndUpdate, updateOne, findOne } }));

const { startSignIn, verifySignInCode, MAX_CODE_ATTEMPTS, CODE_TTL_MS, VERIFIED_TTL_MS } = await import("./platform-sign-in");
const { sha256 } = await import("./oauth");

const lean = (value: unknown) => ({ lean: () => Promise.resolve(value) });

beforeEach(() => {
  vi.clearAllMocks();
});

async function started() {
  const { binder, code } = await startSignIn("  Ann@Example.COM ");
  const row = create.mock.calls[0][0];
  return { binder, code, row };
}

describe("startSignIn (BP-919)", () => {
  it("stores the address normalised and only hashes of the binder and the code, expiring in ten minutes", async () => {
    const before = Date.now();
    const { binder, code, row } = await started();

    expect(code).toMatch(/^\d{6}$/);
    expect(row.email).toBe("ann@example.com");
    expect(row.binderHash).toBe(sha256(binder));
    expect(JSON.stringify(row)).not.toContain(code);
    expect(JSON.stringify(row)).not.toContain(binder);
    expect(row.expiresAt.getTime()).toBeGreaterThanOrEqual(before + CODE_TTL_MS);
  });
});

describe("verifySignInCode (BP-919)", () => {
  it("counts a try before comparing, only on an unverified, unexpired row under the limit", async () => {
    const { binder, code, row } = await started();
    findOneAndUpdate.mockReturnValue(lean({ ...row, attempts: 1 }));
    updateOne.mockResolvedValue({ modifiedCount: 1 });

    expect(await verifySignInCode(binder, code)).toBe("verified");
    const [filter, update] = findOneAndUpdate.mock.calls[0];
    expect(filter).toMatchObject({ binderHash: sha256(binder), verifiedAt: null, attempts: { $lt: MAX_CODE_ATTEMPTS } });
    expect(filter.expiresAt.$gt).toBeInstanceOf(Date);
    expect(update).toEqual({ $inc: { attempts: 1 } });
  });

  it("marks the row verified and gives it fifteen minutes from now", async () => {
    const { binder, code, row } = await started();
    findOneAndUpdate.mockReturnValue(lean(row));
    updateOne.mockResolvedValue({ modifiedCount: 1 });
    const before = Date.now();

    await verifySignInCode(binder, code);

    const [filter, update] = updateOne.mock.calls[0];
    expect(filter).toEqual({ _id: row._id, verifiedAt: null });
    expect(update.$set.expiresAt.getTime()).toBeGreaterThanOrEqual(before + VERIFIED_TTL_MS);
  });

  it("calls a wrong code wrong and verifies nothing", async () => {
    const { binder, code, row } = await started();
    findOneAndUpdate.mockReturnValue(lean(row));

    expect(await verifySignInCode(binder, code === "000000" ? "000001" : "000000")).toBe("wrong");
    expect(updateOne).not.toHaveBeenCalled();
  });

  it("calls the right code expired once the row is spent, out of tries or gone", async () => {
    const { binder, code } = await started();
    findOneAndUpdate.mockReturnValue(lean(null));

    expect(await verifySignInCode(binder, code)).toBe("expired");
    expect(updateOne).not.toHaveBeenCalled();
  });

  it("does not verify twice when another request verified the row in between", async () => {
    const { binder, code, row } = await started();
    findOneAndUpdate.mockReturnValue(lean(row));
    updateOne.mockResolvedValue({ modifiedCount: 0 });

    expect(await verifySignInCode(binder, code)).toBe("expired");
  });

  it("binds the code to its own row: the same digits do not verify another sign-in", async () => {
    const { binder, code } = await started();
    const other = { _id: new Types.ObjectId(), codeHash: sha256(`${new Types.ObjectId()}:${code}`) };
    findOneAndUpdate.mockReturnValue(lean(other));

    expect(await verifySignInCode(binder, code)).toBe("wrong");
  });
});
