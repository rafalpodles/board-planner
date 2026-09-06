import { describe, it, expect, vi, beforeEach } from "vitest";

const getAuthUser = vi.fn();
const check = vi.fn();
const userFindById = vi.fn();
const userCountDocuments = vi.fn();
const userExists = vi.fn();
const revokeUserSessions = vi.fn();
const invalidateResetTokens = vi.fn();
const logInstanceAudit = vi.fn();
const notifyPasswordChanged = vi.fn();
const notifyAddressChanged = vi.fn();
const hash = vi.fn();

vi.mock("@/lib/db", () => ({ connectDB: vi.fn() }));
vi.mock("@/models/rateLimit", async () => {
  const { inMemoryRateLimitModel } = await import("@/lib/rate-limit-test-store");
  return { RateLimit: inMemoryRateLimitModel() };
});
vi.mock("@/lib/auth", () => ({
  getAuthUser,
  RateLimitError: class RateLimitError extends Error {},
  PASSWORD_COST_FACTOR: 10,
  MIN_PASSWORD_LENGTH: 8,
}));
vi.mock("@/lib/grants", () => ({ check, accessibleProjectIds: vi.fn() }));
vi.mock("@/lib/session", () => ({ revokeUserSessions }));
vi.mock("@/lib/password-reset", () => ({ invalidateResetTokens }));
vi.mock("@/lib/instanceAudit", () => ({ logInstanceAudit }));
vi.mock("@/lib/security-mail", () => ({ notifyPasswordChanged, notifyAddressChanged }));
vi.mock("bcryptjs", () => ({ default: { hash } }));
const userFindByIdAndDelete = vi.fn();
vi.mock("@/models/user", () => ({
  User: {
    findById: userFindById,
    countDocuments: userCountDocuments,
    exists: userExists,
    findByIdAndDelete: userFindByIdAndDelete,
  },
}));

const { PUT, DELETE } = await import("./route");
const { resetRateLimits, lockoutKey, recordFailedAttempt, isRateLimited, ANONYMOUS_ACCOUNT_ATTEMPTS } =
  await import("@/lib/rate-limit");

const ADMIN = { _id: "admin-1", role: "admin", username: "rafal" };

function put(body: unknown) {
  return new Request("http://x/api/users/target-1", {
    method: "PUT",
    body: JSON.stringify(body),
  });
}

const ctx = () => ({ params: Promise.resolve({ userId: "target-1" }) });

function targetDoc(overrides: Record<string, unknown> = {}) {
  return {
    _id: "target-1",
    username: "target",
    role: "admin",
    email: "target@example.com",
    kind: "human",
    password: "old-hash",
    save: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function found(target: unknown) {
  userFindById.mockResolvedValue(target);
}

beforeEach(async () => {
  await resetRateLimits();
  vi.clearAllMocks();
  getAuthUser.mockResolvedValue(ADMIN);
  userCountDocuments.mockResolvedValue(2);
  userExists.mockResolvedValue(null);
  hash.mockResolvedValue("new-hash");
});

describe("PUT /api/users/:id", () => {
  it("writes the role and the address, and nothing else the body carries", async () => {
    const target = targetDoc();
    found(target);

    const res = await PUT(
      put({ role: "member", email: "New.Address@Example.com", kind: "machine" }),
      ctx()
    );

    expect(res.status).toBe(200);
    expect(target.role).toBe("member");
    expect(target.email).toBe("new.address@example.com");
    expect(target.kind).toBe("human");
    expect(target.save).toHaveBeenCalled();
  });

  it("leaves the address alone when the body does not carry one", async () => {
    const target = targetDoc();
    found(target);

    await PUT(put({ role: "member" }), ctx());

    expect(target.email).toBe("target@example.com");
  });

  it("clears the address when sent an empty one", async () => {
    const target = targetDoc();
    found(target);

    const res = await PUT(put({ email: "" }), ctx());

    expect(res.status).toBe(200);
    expect(target.email).toBe("");
  });

  it("refuses an address that could never receive anything", async () => {
    const target = targetDoc();
    found(target);

    const res = await PUT(put({ email: "not-an-address" }), ctx());

    expect(res.status).toBe(400);
    expect(target.email).toBe("target@example.com");
    expect(target.save).not.toHaveBeenCalled();
  });

  it("refuses an address change from an admin API token", async () => {
    const target = targetDoc();
    found(target);
    getAuthUser.mockResolvedValue({ ...ADMIN, viaMachineCredential: true });

    const res = await PUT(put({ email: "attacker@example.com" }), ctx());

    expect(res.status).toBe(403);
    expect(target.save).not.toHaveBeenCalled();
  });

  it("answers 409 before revoking anything when the address is taken", async () => {
    const target = targetDoc();
    found(target);
    userExists.mockResolvedValue({ _id: "someone-else" });

    const res = await PUT(put({ email: "taken@example.com", password: "a-fresh-password" }), ctx());

    expect(res.status).toBe(409);
    expect(revokeUserSessions).not.toHaveBeenCalled();
    expect(target.save).not.toHaveBeenCalled();
  });

  it("still answers 409 when the index is the one that catches it", async () => {
    const target = targetDoc();
    found(target);
    target.save.mockRejectedValueOnce(
      Object.assign(new Error("E11000 duplicate key"), {
        code: 11000,
        keyPattern: { email: 1 },
      })
    );

    const res = await PUT(put({ email: "taken@example.com", role: "admin" }), ctx());

    expect(res.status).toBe(409);
    expect(logInstanceAudit).not.toHaveBeenCalled();
  });

  it("does not ask whether an unchanged address is taken", async () => {
    const target = targetDoc();
    found(target);

    await PUT(put({ email: "target@example.com" }), ctx());

    expect(userExists).not.toHaveBeenCalled();
  });
});

describe("PUT /api/users/:id — machine credentials cannot promote", () => {
  it("refuses a role change from an admin API token", async () => {
    const target = targetDoc({ role: "member" });
    found(target);
    getAuthUser.mockResolvedValue({ ...ADMIN, viaMachineCredential: true });

    const res = await PUT(put({ role: "admin" }), ctx());

    expect(res.status).toBe(403);
    expect(target.save).not.toHaveBeenCalled();
  });

  it("still lets an interactive admin change a role", async () => {
    const target = targetDoc({ role: "member" });
    found(target);
    getAuthUser.mockResolvedValue({ ...ADMIN, viaMachineCredential: false });

    const res = await PUT(put({ role: "admin" }), ctx());

    expect(res.status).toBe(200);
    expect(target.save).toHaveBeenCalled();
  });
});

describe("PUT /api/users/:id — an admin sets a password", () => {
  it("lifts the target's login lockout, from every address it was filled from", async () => {
    const shared = lockoutKey("-", "target");
    const fromElsewhere = lockoutKey("203.0.113.9", "target");
    for (let i = 0; i < ANONYMOUS_ACCOUNT_ATTEMPTS; i++) {
      await recordFailedAttempt(shared);
      await recordFailedAttempt(fromElsewhere);
    }
    const target = targetDoc({ role: "member" });
    found(target);

    const response = await PUT(put({ password: "a-brand-new-password" }), ctx());

    expect(response.status).toBe(200);
    expect(await isRateLimited(shared, ANONYMOUS_ACCOUNT_ATTEMPTS)).toBe(false);
    expect(await isRateLimited(fromElsewhere, ANONYMOUS_ACCOUNT_ATTEMPTS)).toBe(false);
  });

  it("leaves the lockout alone when no password was set", async () => {
    const shared = lockoutKey("-", "target");
    for (let i = 0; i < ANONYMOUS_ACCOUNT_ATTEMPTS; i++) await recordFailedAttempt(shared);
    const target = targetDoc({ role: "member" });
    found(target);

    await PUT(put({ role: "admin" }), ctx());

    expect(await isRateLimited(shared, ANONYMOUS_ACCOUNT_ATTEMPTS)).toBe(true);
  });

  it("hashes it, signs the target out everywhere, and leaves a trace", async () => {
    const target = targetDoc({ role: "member" });
    found(target);

    const res = await PUT(put({ password: "a-fresh-password" }), ctx());

    expect(res.status).toBe(200);
    expect(hash).toHaveBeenCalledWith("a-fresh-password", 10);
    expect(target.password).toBe("new-hash");
    expect(target.save).toHaveBeenCalled();
    expect(revokeUserSessions).toHaveBeenCalledWith("target-1");
    expect(invalidateResetTokens).toHaveBeenCalledWith("target-1");
    expect(logInstanceAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "user_password_reset",
        target: "target",
        user: "admin-1",
        actorUsername: "rafal",
      })
    );
  });

  it("tells the account holder, naming the administrator", async () => {
    const target = targetDoc({ role: "member" });
    found(target);

    await PUT(put({ password: "a-fresh-password" }), ctx());

    expect(notifyPasswordChanged).toHaveBeenCalledWith({
      email: "target@example.com",
      username: "target",
      how: "admin",
      actor: "rafal",
    });
    expect(JSON.stringify(notifyPasswordChanged.mock.calls)).not.toContain("a-fresh-password");
  });

  it("warns the address the account had on the way in, not the one it was just given", async () => {
    const target = targetDoc({ role: "member" });
    found(target);

    await PUT(put({ password: "a-fresh-password", email: "attacker@evil.test" }), ctx());

    expect(notifyPasswordChanged).toHaveBeenCalledWith(
      expect.objectContaining({ email: "target@example.com" })
    );
  });

  it("does not pull the hash out of the database", async () => {
    const target = targetDoc({ role: "member" });
    found(target);

    await PUT(put({ password: "a-fresh-password" }), ctx());

    expect(userFindById).toHaveBeenCalledWith("target-1");
  });

  it("refuses a password from an admin API token", async () => {
    const target = targetDoc({ role: "member" });
    found(target);
    getAuthUser.mockResolvedValue({ ...ADMIN, viaMachineCredential: true });

    const res = await PUT(put({ password: "a-fresh-password" }), ctx());

    expect(res.status).toBe(403);
    expect(target.save).not.toHaveBeenCalled();
    expect(revokeUserSessions).not.toHaveBeenCalled();
  });

  it("refuses to set the admin's own password", async () => {
    const target = targetDoc({ _id: "admin-1", role: "admin" });
    found(target);

    const res = await PUT(put({ password: "a-fresh-password" }), ctx());

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "Change your own password under Settings → Security",
    });
    expect(target.save).not.toHaveBeenCalled();
  });

  it("refuses one shorter than the minimum, without touching the account", async () => {
    const target = targetDoc({ role: "member" });
    found(target);

    const res = await PUT(put({ password: "short" }), ctx());

    expect(res.status).toBe(400);
    expect(target.password).toBe("old-hash");
    expect(target.save).not.toHaveBeenCalled();
    expect(revokeUserSessions).not.toHaveBeenCalled();
  });

  it("refuses to give a machine account a password", async () => {
    const target = targetDoc({ role: "member", kind: "machine" });
    found(target);

    const res = await PUT(put({ password: "a-fresh-password" }), ctx());

    expect(res.status).toBe(400);
    expect(hash).not.toHaveBeenCalled();
    expect(target.save).not.toHaveBeenCalled();
  });

  it("refuses to give a machine account an address", async () => {
    const target = targetDoc({ role: "member", kind: "machine" });
    found(target);

    const res = await PUT(put({ email: "attacker@example.com" }), ctx());

    expect(res.status).toBe(400);
    expect(target.save).not.toHaveBeenCalled();
  });

  it("does not change the password when the sessions cannot be revoked", async () => {
    const target = targetDoc({ role: "member" });
    found(target);
    revokeUserSessions.mockRejectedValueOnce(new Error("mongo is having a moment"));

    await expect(PUT(put({ password: "a-fresh-password" }), ctx())).rejects.toThrow();

    expect(target.save).not.toHaveBeenCalled();
  });

  it("refuses a password that is not a string", async () => {
    const target = targetDoc({ role: "member" });
    found(target);

    const res = await PUT(put({ password: { length: 99 } }), ctx());

    expect(res.status).toBe(400);
    expect(hash).not.toHaveBeenCalled();
    expect(target.save).not.toHaveBeenCalled();
  });

  it("leaves sessions alone when only the role changes, and records the change", async () => {
    const target = targetDoc({ role: "member" });
    found(target);

    const res = await PUT(put({ role: "admin" }), ctx());

    expect(res.status).toBe(200);
    expect(revokeUserSessions).not.toHaveBeenCalled();
    expect(logInstanceAudit).toHaveBeenCalledTimes(1);
    expect(logInstanceAudit).toHaveBeenCalledWith({
      action: "user_role_changed",
      user: "admin-1",
      actorUsername: "rafal",
      target: "target",
      detail: "member → admin",
    });
  });

  it("records nothing when the role submitted is the one already stored", async () => {
    const target = targetDoc({ role: "member" });
    found(target);

    const res = await PUT(put({ role: "member" }), ctx());

    expect(res.status).toBe(200);
    expect(logInstanceAudit).not.toHaveBeenCalled();
  });
});

describe("PUT /api/users/:id — an admin repoints the address", () => {
  it("warns the address being taken off the account, naming the administrator", async () => {
    const target = targetDoc({ role: "member" });
    found(target);

    await PUT(put({ email: "new@example.com" }), ctx());

    expect(notifyAddressChanged).toHaveBeenCalledWith({
      previousEmail: "target@example.com",
      username: "target",
      newEmail: "new@example.com",
      actor: "rafal",
    });
  });

  it("stays quiet when the address submitted is the one already stored", async () => {
    const target = targetDoc({ role: "member" });
    found(target);

    await PUT(put({ email: "target@example.com" }), ctx());

    expect(notifyAddressChanged).not.toHaveBeenCalled();
  });
});

describe("DELETE /api/users/:id", () => {
  const ADMIN_HEX = "6a9d0f0b5d781bded2cb9759";
  const TARGET_HEX = "6a9d0f0b5d781bded2cb975a";
  const ADMIN_DOC = { _id: ADMIN_HEX, role: "admin", username: "rafal", kind: "human" };

  const del = (id: string) =>
    [
      new Request(`http://x/api/users/${id}`, { method: "DELETE" }),
      { params: Promise.resolve({ userId: id }) },
    ] as const;

  function person(overrides: Record<string, unknown> = {}) {
    return { _id: TARGET_HEX, username: "target", role: "member", kind: "human", ...overrides };
  }

  beforeEach(() => {
    getAuthUser.mockResolvedValue({ ...ADMIN_DOC, viaMachineCredential: false });
    userCountDocuments.mockResolvedValue(2);
    userFindByIdAndDelete.mockResolvedValue(person());
  });

  it("deletes the account it was asked about, and ends that account's sessions", async () => {
    found(person());

    const res = await DELETE(...del(TARGET_HEX));

    expect(res.status).toBe(200);
    expect(userFindByIdAndDelete).toHaveBeenCalledWith(TARGET_HEX);
    expect(revokeUserSessions).toHaveBeenCalledWith(TARGET_HEX);
  });

  it("acts on the id the database resolved, not the one that was typed", async () => {
    found(person());

    const res = await DELETE(...del(TARGET_HEX.toUpperCase()));

    expect(res.status).toBe(200);
    expect(userFindByIdAndDelete).toHaveBeenCalledWith(TARGET_HEX);
    expect(revokeUserSessions).toHaveBeenCalledWith(TARGET_HEX);
  });

  it("refuses a machine credential", async () => {
    getAuthUser.mockResolvedValue({ ...ADMIN_DOC, viaMachineCredential: true });
    found(person());

    const res = await DELETE(...del(TARGET_HEX));

    expect(res.status).toBe(403);
    expect(userFindByIdAndDelete).not.toHaveBeenCalled();
    expect(revokeUserSessions).not.toHaveBeenCalled();
  });

  it("refuses the caller their own account", async () => {
    found(person({ _id: ADMIN_HEX, role: "admin" }));

    const res = await DELETE(...del(ADMIN_HEX));

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "Cannot delete yourself" });
    expect(userFindByIdAndDelete).not.toHaveBeenCalled();
  });

  it("refuses it in upper case too, because that is the same account", async () => {
    found(person({ _id: ADMIN_HEX, role: "admin" }));

    const res = await DELETE(...del(ADMIN_HEX.toUpperCase()));

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "Cannot delete yourself" });
    expect(userFindByIdAndDelete).not.toHaveBeenCalled();
  });

  it("refuses the last administrator", async () => {
    found(person({ role: "admin" }));
    userCountDocuments.mockResolvedValue(1);

    const res = await DELETE(...del(TARGET_HEX));

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "Cannot delete the last admin" });
    expect(userCountDocuments).toHaveBeenCalledWith({ role: "admin" });
    expect(userFindByIdAndDelete).not.toHaveBeenCalled();
  });

  it("still deletes a member on an instance with a single administrator", async () => {
    found(person({ role: "member" }));
    userCountDocuments.mockResolvedValue(1);

    const res = await DELETE(...del(TARGET_HEX));

    expect(res.status).toBe(200);
    expect(userFindByIdAndDelete).toHaveBeenCalledWith(TARGET_HEX);
  });

  it("still deletes an admin while another one remains, and says so in the row", async () => {
    found(person({ role: "admin" }));
    userCountDocuments.mockResolvedValue(2);

    const res = await DELETE(...del(TARGET_HEX));

    expect(res.status).toBe(200);
    expect(userFindByIdAndDelete).toHaveBeenCalled();
    expect(logInstanceAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "user_deleted", detail: "an administrator" })
    );
  });

  it("refuses a machine account", async () => {
    found(person({ kind: "machine" }));

    const res = await DELETE(...del(TARGET_HEX));

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      error: "A machine account is released under Settings → Workers, not deleted here",
    });
    expect(userFindByIdAndDelete).not.toHaveBeenCalled();
  });

  it("answers 404 for an account that is not there, without deleting anything", async () => {
    found(null);

    const res = await DELETE(...del(TARGET_HEX));

    expect(res.status).toBe(404);
    expect(userFindByIdAndDelete).not.toHaveBeenCalled();
    expect(revokeUserSessions).not.toHaveBeenCalled();
  });

  it("records the deletion, naming the account and who did it", async () => {
    found(person({ role: "member" }));

    await DELETE(...del(TARGET_HEX));

    expect(logInstanceAudit).toHaveBeenCalledWith({
      action: "user_deleted",
      user: ADMIN_HEX,
      actorUsername: "rafal",
      target: "target",
      detail: "a member",
    });
  });

  it("records the deletion even if ending the sessions fails", async () => {
    found(person());
    revokeUserSessions.mockRejectedValueOnce(new Error("mongo is away"));

    await expect(DELETE(...del(TARGET_HEX))).rejects.toThrow();

    expect(logInstanceAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "user_deleted", target: "target" })
    );
  });

  it("records nothing when the delete was refused", async () => {
    found(person({ _id: ADMIN_HEX, role: "admin" }));

    const res = await DELETE(...del(ADMIN_HEX));

    expect(res.status).toBe(400);
    expect(logInstanceAudit).not.toHaveBeenCalled();
  });

  it("answers 404 when the account goes between the checks and the delete", async () => {
    found(person());
    userFindByIdAndDelete.mockResolvedValue(null);

    const res = await DELETE(...del(TARGET_HEX));

    expect(res.status).toBe(404);
    expect(revokeUserSessions).not.toHaveBeenCalled();
    expect(logInstanceAudit).not.toHaveBeenCalled();
  });

  it("answers 404 for an id that is not an id, rather than throwing", async () => {
    const res = await DELETE(...del("not-an-object-id"));

    expect(res.status).toBe(404);
    expect(userFindById).not.toHaveBeenCalled();
  });

  it("refuses a machine credential before it says whether the account exists", async () => {
    getAuthUser.mockResolvedValue({ ...ADMIN_DOC, viaMachineCredential: true });
    found(null);

    const res = await DELETE(...del(TARGET_HEX));

    expect(res.status).toBe(403);
    expect(userFindById).not.toHaveBeenCalled();
  });
});

describe("PUT /api/users/:id — the guards that keep an administrator standing", () => {
  it("refuses to demote the last admin", async () => {
    const target = targetDoc({ _id: "target-1", role: "admin" });
    found(target);
    userCountDocuments.mockResolvedValue(1);

    const res = await PUT(put({ role: "member" }), ctx());

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "Cannot demote the last admin" });
    expect(target.save).not.toHaveBeenCalled();
  });

  it("demotes an admin while another one remains", async () => {
    const target = targetDoc({ role: "admin" });
    found(target);
    userCountDocuments.mockResolvedValue(2);

    const res = await PUT(put({ role: "member" }), ctx());

    expect(res.status).toBe(200);
    expect(target.role).toBe("member");
  });

  it("refuses to change your own role", async () => {
    const target = targetDoc({ _id: "admin-1", role: "admin" });
    found(target);
    userCountDocuments.mockResolvedValue(5);

    const res = await PUT(put({ role: "member" }), ctx());

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "Cannot change your own role" });
    expect(target.save).not.toHaveBeenCalled();
  });
});
