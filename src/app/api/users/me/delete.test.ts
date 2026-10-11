import { describe, it, expect, vi, beforeEach } from "vitest";

const getAuthUser = vi.fn();
const compare = vi.fn();
const signedInRecently = vi.fn();
const revokeUserCredentials = vi.fn();
const eraseAccountTraces = vi.fn(async (..._args: unknown[]) => "deleted-label");
const logInstanceAudit = vi.fn();
const boardsOnlyOwnedBy = vi.fn();
const boardsLeftWithoutOwner = vi.fn(async (_id?: string) => [] as string[]);
const userFindById = vi.fn();
const userUpdateOne = vi.fn();
const userCountDocuments = vi.fn();
const userFindByIdAndDelete = vi.fn();
const grantDeleteMany = vi.fn();

vi.mock("@/lib/db", () => ({ connectDB: vi.fn() }));
vi.mock("@/models/rateLimit", async () => {
  const { inMemoryRateLimitModel } = await import("@/lib/rate-limit-test-store");
  return { RateLimit: inMemoryRateLimitModel() };
});
vi.mock("@/lib/auth", () => ({
  getAuthUser,
  getClientIp: () => "203.0.113.9",
  PASSWORD_COST_FACTOR: 10,
  MIN_PASSWORD_LENGTH: 8,
}));
vi.mock("@/lib/session", () => ({
  ProvenanceError: class ProvenanceError extends Error {},
  RECENT_SIGN_IN_REQUIRED: "sign in again first",
  signedInRecently,
  revokeUserCredentials,
  clearSessionCookies: () => ["bp_session=; Max-Age=0"],
}));
vi.mock("@/lib/account-erasure", () => ({ eraseAccountTraces }));
vi.mock("@/lib/instanceAudit", () => ({ logInstanceAudit }));
vi.mock("@/lib/grants", () => ({ check: vi.fn(), accessibleProjectIds: vi.fn(), boardsOnlyOwnedBy, boardsLeftWithoutOwner }));
vi.mock("@/models/grant", () => ({ Grant: { deleteMany: grantDeleteMany } }));
vi.mock("@/lib/password-sign-in", async (original) => ({
  ...(await original<typeof import("@/lib/password-sign-in")>()),
  warnIfAdminsLockedOut: vi.fn(),
}));
vi.mock("bcryptjs", () => ({ default: { compare } }));
vi.mock("@/models/user", () => ({
  User: {
    findOne: userFindById,
    updateOne: userUpdateOne,
    countDocuments: userCountDocuments,
    findOneAndDelete: userFindByIdAndDelete,
  },
}));

const { DELETE } = await import("./route");
const { resetRateLimits, EXCLUSIVE_SOURCE_ATTEMPTS } = await import("@/lib/rate-limit");

const ME = { _id: "u1", username: "jan", role: "member", kind: "human", sessionId: "s1", viaMachineCredential: false };

function request(body?: unknown) {
  return new Request("https://app.example.com/api/users/me", {
    method: "DELETE",
    headers: { "content-type": "application/json", "sec-fetch-site": "same-origin" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
const context = { params: Promise.resolve({}) };

function accountRecord(overrides: Record<string, unknown> = {}) {
  const record = { _id: "u1", username: "jan", role: "member", kind: "human", deactivatedAt: null, password: "stored-hash", ...overrides };
  userFindById.mockReturnValue(Object.assign(Promise.resolve(record), { select: () => Promise.resolve(record) }));
  userFindByIdAndDelete.mockResolvedValue(record);
  return record;
}

beforeEach(async () => {
  vi.clearAllMocks();
  await resetRateLimits();
  delete process.env.PASSWORD_SIGN_IN;
  getAuthUser.mockResolvedValue(ME);
  accountRecord();
  userUpdateOne.mockResolvedValue({ modifiedCount: 1 });
  userCountDocuments.mockResolvedValue(2);
  boardsOnlyOwnedBy.mockResolvedValue([]);
  compare.mockResolvedValue(true);
  signedInRecently.mockResolvedValue(true);
});

describe("DELETE /api/users/me — a person deletes their own account", () => {
  it("deletes it with the right password, signing the browser out and naming nothing in the log", async () => {
    const res = await DELETE(request({ currentPassword: "correct horse" }), context);

    expect(res.status).toBe(200);
    expect(res.headers.get("set-cookie")).toContain("Max-Age=0");
    expect(userFindByIdAndDelete).toHaveBeenCalled();
    expect(revokeUserCredentials).toHaveBeenCalledWith("u1");
    expect(logInstanceAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: "user_deleted", target: "deleted-label", actorUsername: "deleted-label", detail: "by the person themselves" })
    );
    const row = JSON.stringify(logInstanceAudit.mock.calls[0][1]);
    expect(row).not.toContain("jan");
  });

  it("refuses without the password, deleting nothing", async () => {
    const res = await DELETE(request({}), context);

    expect(res.status).toBe(400);
    expect(userFindByIdAndDelete).not.toHaveBeenCalled();
    expect(eraseAccountTraces).not.toHaveBeenCalled();
  });

  it("refuses a wrong password, deleting nothing", async () => {
    compare.mockResolvedValue(false);

    const res = await DELETE(request({ currentPassword: "nope" }), context);

    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("Current password is incorrect");
    expect(userFindByIdAndDelete).not.toHaveBeenCalled();
  });

  it("asks for a recent sign-in instead when the account has no password", async () => {
    accountRecord({ password: undefined });
    signedInRecently.mockResolvedValue(false);

    const res = await DELETE(request({}), context);

    expect(res.status).toBe(403);
    expect(userFindByIdAndDelete).not.toHaveBeenCalled();

    signedInRecently.mockResolvedValue(true);
    expect((await DELETE(request({}), context)).status).toBe(200);
  });

  it("refuses a machine credential, however it was proven", async () => {
    getAuthUser.mockResolvedValue({ ...ME, viaMachineCredential: true });

    const res = await DELETE(request({ currentPassword: "correct horse" }), context);

    expect(res.status).toBe(403);
    expect(userFindByIdAndDelete).not.toHaveBeenCalled();
  });

  it("refuses a machine account", async () => {
    getAuthUser.mockResolvedValue({ ...ME, kind: "machine" });

    expect((await DELETE(request({ currentPassword: "x" }), context)).status).toBe(400);
    expect(userFindByIdAndDelete).not.toHaveBeenCalled();
  });

  it("tells the last administrator why they cannot go", async () => {
    getAuthUser.mockResolvedValue({ ...ME, role: "admin" });
    accountRecord({ role: "admin" });
    userCountDocuments.mockResolvedValue(1);

    const res = await DELETE(request({ currentPassword: "correct horse" }), context);

    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/last administrator/);
    expect(userFindByIdAndDelete).not.toHaveBeenCalled();
  });

  it("tells a sole board owner which board to hand over", async () => {
    boardsOnlyOwnedBy.mockResolvedValue([{ name: "Alpha", key: "AL" }]);

    const res = await DELETE(request({ currentPassword: "correct horse" }), context);

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe("You are the only owner of Alpha (AL). Make someone else an owner there before deleting your account.");
    expect(userFindByIdAndDelete).not.toHaveBeenCalled();
    expect(eraseAccountTraces).not.toHaveBeenCalled();
  });

  it("erases the traces before the account row is deleted", async () => {
    await DELETE(request({ currentPassword: "correct horse" }), context);

    expect(eraseAccountTraces.mock.invocationCallOrder[0]).toBeLessThan(userFindByIdAndDelete.mock.invocationCallOrder[0]);
  });

  it("treats an account with a password as having none while password sign-in is off", async () => {
    process.env.PASSWORD_SIGN_IN = "off";
    signedInRecently.mockResolvedValue(false);

    expect((await DELETE(request({ currentPassword: "correct horse" }), context)).status).toBe(403);
    expect(compare).not.toHaveBeenCalled();
    expect(userFindByIdAndDelete).not.toHaveBeenCalled();

    signedInRecently.mockResolvedValue(true);
    expect((await DELETE(request({}), context)).status).toBe(200);
  });

  it("locks out guessing: after enough wrong passwords even the right one is refused", async () => {
    compare.mockResolvedValue(false);
    for (let attempt = 0; attempt < EXCLUSIVE_SOURCE_ATTEMPTS; attempt++) {
      await DELETE(request({ currentPassword: "wrong" }), context);
    }
    compare.mockResolvedValue(true);

    const res = await DELETE(request({ currentPassword: "correct horse" }), context);

    expect(res.status).toBe(429);
    expect(userFindByIdAndDelete).not.toHaveBeenCalled();
  });

  it("forgets earlier wrong guesses once the right password is given", async () => {
    const guesses = EXCLUSIVE_SOURCE_ATTEMPTS - 1;
    for (let round = 0; round < 2; round++) {
      compare.mockResolvedValue(false);
      for (let attempt = 0; attempt < guesses; attempt++) await DELETE(request({ currentPassword: "wrong" }), context);
      compare.mockResolvedValue(true);
      // Without the reset the second round's right password would be the 2·N-th guess, and be locked out
      const res = await DELETE(request({ currentPassword: "correct horse" }), context);
      expect(res.status).toBe(200);
      accountRecord();
    }
  });

  it("answers 404 when the account is already gone", async () => {
    userFindById.mockReturnValue(Object.assign(Promise.resolve(null), { select: () => Promise.resolve(null) }));

    expect((await DELETE(request({ currentPassword: "correct horse" }), context)).status).toBe(404);
    expect(userFindByIdAndDelete).not.toHaveBeenCalled();
  });

  it("gives back its deactivation mark when a board would be left ownerless by a racing change", async () => {
    boardsLeftWithoutOwner.mockResolvedValueOnce(["p1"]);

    const res = await DELETE(request({ currentPassword: "correct horse" }), context);

    expect(res.status).toBe(409);
    const marked = userUpdateOne.mock.calls[0][1].$set.deactivatedAt;
    expect(userUpdateOne).toHaveBeenLastCalledWith(
      expect.objectContaining({ deactivatedAt: marked }),
      { $set: { deactivatedAt: null } }
    );
    expect(userFindByIdAndDelete).not.toHaveBeenCalled();
    expect(eraseAccountTraces).not.toHaveBeenCalled();
  });

  it("is not stranded by a failed erasure: the mark is given back, nothing is deleted or revoked", async () => {
    eraseAccountTraces.mockRejectedValueOnce(new Error("mongo is away"));

    await expect(DELETE(request({ currentPassword: "correct horse" }), context)).rejects.toThrow("mongo is away");

    const marked = userUpdateOne.mock.calls[0][1].$set.deactivatedAt;
    expect(userUpdateOne).toHaveBeenLastCalledWith(
      expect.objectContaining({ deactivatedAt: marked }),
      { $set: { deactivatedAt: null } }
    );
    expect(userFindByIdAndDelete).not.toHaveBeenCalled();
    expect(revokeUserCredentials).not.toHaveBeenCalled();
  });

  it("ends the credentials only after the account is gone, so a failure never unlinks a way in", async () => {
    await DELETE(request({ currentPassword: "correct horse" }), context);

    expect(revokeUserCredentials.mock.invocationCallOrder[0]).toBeGreaterThan(userFindByIdAndDelete.mock.invocationCallOrder[0]);
  });
});
