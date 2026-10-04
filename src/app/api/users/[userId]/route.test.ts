import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { DEFAULT_TENANT_ID } from "@/lib/tenant-field";

const getAuthUser = vi.fn();
const check = vi.fn();
const userFindOne = vi.fn();
const userCountDocuments = vi.fn();
const userExists = vi.fn();
const revokeUserSessions = vi.fn();
const revokeUserCredentials = vi.fn();
const invalidateResetTokens = vi.fn();
const logInstanceAudit = vi.fn();
const notifyPasswordChanged = vi.fn();
const notifyAddressChanged = vi.fn();
const hash = vi.fn();

vi.mock("@/lib/db", () => ({ connectDB: vi.fn() }));
const revokePendingInvitationsFor = vi.fn();
vi.mock("@/lib/invitations", () => ({ revokePendingInvitationsFor }));
// Setting a password clears the target's login lockout (BP-353), which reaches the counter store
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
const boardsOnlyOwnedBy = vi.fn();
const grantDeleteMany = vi.fn();
const boardsLeftWithoutOwner = vi.fn(async (_id?: string) => [] as string[]);
vi.mock("@/lib/grants", () => ({ check, accessibleProjectIds: vi.fn(), boardsOnlyOwnedBy, boardsLeftWithoutOwner }));
vi.mock("@/models/grant", () => ({ Grant: { deleteMany: grantDeleteMany } }));
const identityDeleteMany = vi.fn();
vi.mock("@/models/identity", () => ({ Identity: { deleteMany: identityDeleteMany } }));
vi.mock("@/lib/session", () => ({ revokeUserSessions, revokeUserCredentials }));
vi.mock("@/lib/password-reset", () => ({ invalidateResetTokens }));
const cancelEmailChange = vi.fn();
vi.mock("@/lib/email-change", () => ({ cancelEmailChange }));
vi.mock("@/lib/instanceAudit", () => ({ logInstanceAudit }));
vi.mock("@/lib/security-mail", () => ({ notifyPasswordChanged, notifyAddressChanged }));
vi.mock("bcryptjs", () => ({ default: { hash } }));
const userFindOneAndDelete = vi.fn();
const userUpdateOne = vi.fn();
vi.mock("@/models/user", () => ({
  User: {
    updateOne: userUpdateOne,
    findOne: userFindOne,
    countDocuments: userCountDocuments,
    exists: userExists,
    findOneAndDelete: userFindOneAndDelete,
  },
}));

const { PUT, DELETE } = await import("./route");
const { scopedToDefaultTenant } = await import("@/lib/db-scope");
const { resetRateLimits, lockoutKey, recordFailedAttempt, isRateLimited, ANONYMOUS_ACCOUNT_ATTEMPTS } =
  await import("@/lib/rate-limit");

const ADMIN = { _id: "admin-1", role: "admin", username: "owner" };

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
    emailVerifiedAt: new Date("2026-01-01T00:00:00Z") as Date | null,
    deactivatedAt: null as Date | null,
    username: "target",
    role: "admin",
    email: "target@example.com",
    kind: "human",
    password: "old-hash",
    save: vi.fn().mockResolvedValue(undefined),
    unmarkModified: vi.fn(),
    ...overrides,
  };
}

function found(target: unknown) {
  userFindOne.mockResolvedValue(target);
}

beforeEach(async () => {
  await resetRateLimits();
  vi.clearAllMocks();
  getAuthUser.mockResolvedValue(ADMIN);
  userCountDocuments.mockResolvedValue(2);
  userExists.mockResolvedValue(null);
  userUpdateOne.mockResolvedValue({ modifiedCount: 1 });
  hash.mockResolvedValue("new-hash");
});

describe("PUT /api/users/:id", () => {
  // Board access lives entirely in the grants collection now, so this endpoint writes the role,
  // the address and the password — and nothing else a client sends. BP-281 added the address on
  // purpose: an account whose owner cannot sign in has no other way to be given one, and without
  // an address there is nowhere to send a reset. `kind` is not on that list, and a request that
  // carries it — an old build, a stale bookmarklet, a hostile caller — must still be ignored.
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
    // An address an administrator typed is a claim, never a proof a sign-in provider may link by
    expect(target.emailVerifiedAt).toBeNull();
    expect(target.kind).toBe("human");
    expect(target.save).toHaveBeenCalled();
    // BP-359 review: a change the account asked for itself would otherwise overwrite this one
    expect(cancelEmailChange).toHaveBeenCalledWith(scopedToDefaultTenant(), "target-1");
    expect(revokePendingInvitationsFor).toHaveBeenCalledWith(scopedToDefaultTenant(), "new.address@example.com");
  });

  it("leaves the address alone when the body does not carry one", async () => {
    const target = targetDoc();
    found(target);

    await PUT(put({ role: "member" }), ctx());

    expect(target.email).toBe("target@example.com");
    expect(cancelEmailChange).not.toHaveBeenCalled();
    expect(revokePendingInvitationsFor).not.toHaveBeenCalled();
  });

  // The only way to undo a typo that took an address somebody else needs
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

  // Whoever writes this field decides where a reset link lands, so it is gated like the password
  it("refuses an address change from an admin API token", async () => {
    const target = targetDoc();
    found(target);
    getAuthUser.mockResolvedValue({ ...ADMIN, viaMachineCredential: true });

    const res = await PUT(put({ email: "attacker@example.com" }), ctx());

    expect(res.status).toBe(403);
    expect(target.save).not.toHaveBeenCalled();
  });

  // Asked before anything is touched, because a password change in the same request revokes the
  // target's sessions before the save: learning of the collision from the index would sign
  // somebody out of everything over an address that was never stored
  it("answers 409 before revoking anything when the address is taken", async () => {
    const target = targetDoc();
    found(target);
    userExists.mockResolvedValue({ _id: "someone-else" });

    const res = await PUT(put({ email: "taken@example.com", password: "a-fresh-password" }), ctx());

    expect(res.status).toBe(409);
    expect(revokeUserCredentials).not.toHaveBeenCalled();
    expect(target.save).not.toHaveBeenCalled();
  });

  // The pre-check races a concurrent write, so the index stays the final arbiter
  it("still answers 409 when the index is the one that catches it", async () => {
    const target = targetDoc();
    found(target);
    target.save.mockRejectedValueOnce(
      Object.assign(new Error("E11000 duplicate key"), {
        code: 11000,
        keyPattern: { email: 1 },
      })
    );

    // The screen sends `role` on every save (`settings/users/page.tsx`), so this request carries
    // one too: the save rolls back, and a row saying the role changed would record something that
    // did not happen
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
  // Creating an account and raising it is how a machine credential escapes the five endpoints that
  // refuse it: make the user, promote it, sign in as it. The gate is only coherent if it also
  // covers the manufacture of the identity.
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
  // BP-353. Handing somebody a password is the administrator's answer to "I cannot get in", so it
  // has to lift a login lockout as well — including one an attacker aimed at them, which on a
  // deployment with no client address anybody can fill. The mock alone proved nothing.
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

  it("records the providers it unlinked, attributed to the administrator", async () => {
    found(targetDoc({ role: "member" }));
    revokeUserCredentials.mockResolvedValueOnce({ identitiesUnlinked: 2 });

    await PUT(put({ password: "a-fresh-password" }), ctx());

    expect(logInstanceAudit).toHaveBeenCalledWith(
      scopedToDefaultTenant(),
      expect.objectContaining({ action: "identity_unlinked", user: "admin-1", target: "target" })
    );
  });

  it("records no unlinking when the target had no provider", async () => {
    found(targetDoc({ role: "member" }));
    revokeUserCredentials.mockResolvedValueOnce({ identitiesUnlinked: 0 });

    await PUT(put({ password: "a-fresh-password" }), ctx());

    expect(logInstanceAudit).not.toHaveBeenCalledWith(scopedToDefaultTenant(), expect.objectContaining({ action: "identity_unlinked" }));
  });

  it("hashes it, signs the target out everywhere, and leaves a trace", async () => {
    const target = targetDoc({ role: "member" });
    found(target);

    const res = await PUT(put({ password: "a-fresh-password" }), ctx());

    expect(res.status).toBe(200);
    expect(hash).toHaveBeenCalledWith("a-fresh-password", 10);
    // The plaintext must never be what lands on the document
    expect(target.password).toBe("new-hash");
    expect(target.save).toHaveBeenCalled();
    // No exception argument: the admin holds none of the target's sessions, and whoever knew the
    // old password must not stay signed in on one
    expect(revokeUserCredentials).toHaveBeenCalledWith("target-1");
    // A reset link already in their inbox would otherwise still overwrite what the admin just set
    expect(invalidateResetTokens).toHaveBeenCalledWith(scopedToDefaultTenant(), "target-1");
    // The actor, not just the subject: a log naming the target as the one who acted is worse than
    // no log, because it reads as a confession by the wrong person
    expect(logInstanceAudit).toHaveBeenCalledWith(
      scopedToDefaultTenant(),
      expect.objectContaining({
        action: "user_password_reset",
        target: "target",
        user: "admin-1",
        // The name beside the reference, because the reference stops naming this administrator the
        // day their own account goes (BP-539)
        actorUsername: "owner",
      })
    );
  });

  // The account holder is the only person this happens to who was not in the room for it, and
  // until now the audit row was the whole of what it left behind
  it("tells the account holder, naming the administrator", async () => {
    const target = targetDoc({ role: "member" });
    found(target);

    await PUT(put({ password: "a-fresh-password" }), ctx());

    expect(notifyPasswordChanged).toHaveBeenCalledWith({
      tenant: DEFAULT_TENANT_ID,
      email: "target@example.com",
      username: "target",
      how: "admin",
      actor: "owner",
    });
    // Whatever the mail says, it is not this
    expect(JSON.stringify(notifyPasswordChanged.mock.calls)).not.toContain("a-fresh-password");
  });

  // One PUT can set a password and repoint the address. Telling the address the request just
  // installed would send the warning to whoever took the account over.
  it("warns the address the account had on the way in, not the one it was just given", async () => {
    const target = targetDoc({ role: "member" });
    found(target);

    await PUT(put({ password: "a-fresh-password", email: "attacker@evil.test" }), ctx());

    expect(notifyPasswordChanged).toHaveBeenCalledWith(
      expect.objectContaining({ email: "target@example.com" })
    );
  });

  // The hash must never be loaded, so it can never be serialised back to the caller
  it("does not pull the hash out of the database", async () => {
    const target = targetDoc({ role: "member" });
    found(target);

    await PUT(put({ password: "a-fresh-password" }), ctx());

    expect(userFindOne).toHaveBeenCalledWith({ _id: "target-1", tenant: DEFAULT_TENANT_ID });
  });

  it("refuses a password from an admin API token", async () => {
    const target = targetDoc({ role: "member" });
    found(target);
    getAuthUser.mockResolvedValue({ ...ADMIN, viaMachineCredential: true });

    const res = await PUT(put({ password: "a-fresh-password" }), ctx());

    expect(res.status).toBe(403);
    expect(target.save).not.toHaveBeenCalled();
    expect(revokeUserCredentials).not.toHaveBeenCalled();
  });

  // Otherwise this is the way around the current-password check that guards Settings → Security
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
    expect(revokeUserCredentials).not.toHaveBeenCalled();
  });

  // A worker's hash is random so that nobody can sign in as it, and the account is filtered out of
  // Settings → Users — a password here would produce a working login nobody can see
  it("refuses to give a machine account a password", async () => {
    const target = targetDoc({ role: "member", kind: "machine" });
    found(target);

    const res = await PUT(put({ password: "a-fresh-password" }), ctx());

    expect(res.status).toBe(400);
    expect(hash).not.toHaveBeenCalled();
    expect(target.save).not.toHaveBeenCalled();
  });

  // The other half of the same promise: an address is what a reset link follows, so refusing the
  // password and allowing the address only moves the escape one slice later
  it("refuses to give a machine account an address", async () => {
    const target = targetDoc({ role: "member", kind: "machine" });
    found(target);

    const res = await PUT(put({ email: "attacker@example.com" }), ctx());

    expect(res.status).toBe(400);
    expect(target.save).not.toHaveBeenCalled();
  });

  // A revoke that throws must leave the account exactly as it was, or the admin sees a failure
  // while the new password is already live
  it("does not change the password when the sessions cannot be revoked", async () => {
    const target = targetDoc({ role: "member" });
    found(target);
    revokeUserCredentials.mockRejectedValueOnce(new Error("mongo is having a moment"));

    await expect(PUT(put({ password: "a-fresh-password" }), ctx())).rejects.toThrow();

    expect(target.save).not.toHaveBeenCalled();
  });

  // A JSON body is whatever the caller sends; `{password: {length: 99}}` must not reach bcrypt
  it("refuses a password that is not a string", async () => {
    const target = targetDoc({ role: "member" });
    found(target);

    const res = await PUT(put({ password: { length: 99 } }), ctx());

    expect(res.status).toBe(400);
    expect(hash).not.toHaveBeenCalled();
    expect(target.save).not.toHaveBeenCalled();
  });

  // The revoke hangs off the password flag and a role-only edit must not trip it. The audit row
  // does not: since BP-538 a role change writes one of its own, which is the whole point — this is
  // the escalation path the branch above gates on `viaMachineCredential`, and it used to leave no
  // trace at all.
  it("leaves sessions alone when only the role changes, and records the change", async () => {
    const target = targetDoc({ role: "member" });
    found(target);

    const res = await PUT(put({ role: "admin" }), ctx());

    expect(res.status).toBe(200);
    expect(revokeUserCredentials).not.toHaveBeenCalled();
    expect(logInstanceAudit).toHaveBeenCalledTimes(1);
    expect(logInstanceAudit).toHaveBeenCalledWith(scopedToDefaultTenant(), {
      action: "user_role_changed",
      user: "admin-1",
      actorUsername: "owner",
      target: "target",
      // The direction, because "role changed" answers half the question somebody is asking
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

// Repointing an address takes the account over at the next reset and signs nobody out. The self
// path has warned the losing address since BP-354; done by an admin it was silent, which is the
// half a borrowed admin session actually uses.
describe("PUT /api/users/:id — an admin repoints the address", () => {
  it("warns the address being taken off the account, naming the administrator", async () => {
    const target = targetDoc({ role: "member" });
    found(target);

    await PUT(put({ email: "new@example.com" }), ctx());

    expect(notifyAddressChanged).toHaveBeenCalledWith({
      previousEmail: "target@example.com",
      username: "target",
      newEmail: "new@example.com",
      actor: "owner",
    });
  });

  it("stays quiet when the address submitted is the one already stored", async () => {
    const target = targetDoc({ role: "member" });
    found(target);

    await PUT(put({ email: "target@example.com" }), ctx());

    expect(notifyAddressChanged).not.toHaveBeenCalled();
  });
});

/**
 * BP-546 and BP-537. The handler nothing tested at all.
 *
 * The ids here are real hex because one of these tests is about their case. Mongo resolves a
 * 24-character hex id case-insensitively, so `User.findById` answering with the same document for
 * either spelling is not a convenience of the mock — it is what the database does, and it is the
 * whole bug.
 */
describe("DELETE /api/users/:id", () => {
  const ADMIN_HEX = "6a9d0f0b5d781bded2cb9759";
  const TARGET_HEX = "6a9d0f0b5d781bded2cb975a";
  const ADMIN_DOC = { _id: ADMIN_HEX, role: "admin", username: "owner", kind: "human" };

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
    userFindOneAndDelete.mockResolvedValue(person());
    boardsOnlyOwnedBy.mockResolvedValue([]);
  });

  // BP-841. A delete cannot be undone, so the account stops counting first and both rules are
  // counted again without it
  describe("when a racing request took the other admin or owner", () => {
    it("marks the account deactivated before deleting it", async () => {
      found(person());

      expect((await DELETE(...del(TARGET_HEX))).status).toBe(200);
      expect(userUpdateOne).toHaveBeenCalledWith(
        { _id: TARGET_HEX, deactivatedAt: null, tenant: DEFAULT_TENANT_ID },
        { $set: { deactivatedAt: expect.any(Date) } }
      );
      expect(userUpdateOne.mock.invocationCallOrder[0]).toBeLessThan(userFindOneAndDelete.mock.invocationCallOrder[0]);
    });

    it("refuses, deleting nothing, when no active admin would be left", async () => {
      found(person({ role: "admin" }));
      userCountDocuments.mockResolvedValueOnce(2).mockResolvedValueOnce(0);

      const res = await DELETE(...del(TARGET_HEX));

      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ error: "Cannot delete the last admin" });
      expect(userCountDocuments).toHaveBeenLastCalledWith({
        role: "admin",
        deactivatedAt: null,
        tenant: DEFAULT_TENANT_ID,
      });
      // Only its own mark: a deactivation that landed meanwhile stays
      expect(userUpdateOne).toHaveBeenLastCalledWith(
        {
          _id: TARGET_HEX,
          deactivatedAt: userUpdateOne.mock.calls[0][1].$set.deactivatedAt,
          tenant: DEFAULT_TENANT_ID,
        },
        { $set: { deactivatedAt: null } }
      );
      expect(userFindOneAndDelete).not.toHaveBeenCalled();
    });

    it("refuses, deleting nothing, when a board it owns would have no active owner", async () => {
      found(person());
      boardsLeftWithoutOwner.mockResolvedValueOnce(["p1"]);

      const res = await DELETE(...del(TARGET_HEX));

      expect(res.status).toBe(409);
      expect(boardsLeftWithoutOwner).toHaveBeenCalledWith(scopedToDefaultTenant(), TARGET_HEX);
      expect(userUpdateOne).toHaveBeenLastCalledWith(
        {
          _id: TARGET_HEX,
          deactivatedAt: userUpdateOne.mock.calls[0][1].$set.deactivatedAt,
          tenant: DEFAULT_TENANT_ID,
        },
        { $set: { deactivatedAt: null } }
      );
      expect(userFindOneAndDelete).not.toHaveBeenCalled();
    });

    it("counts nothing again for an account already deactivated, which counted for nothing", async () => {
      found(person({ role: "admin", deactivatedAt: new Date() }));
      userFindOneAndDelete.mockResolvedValue(person({ role: "admin", deactivatedAt: new Date() }));

      expect((await DELETE(...del(TARGET_HEX))).status).toBe(200);
      expect(userUpdateOne).not.toHaveBeenCalled();
      expect(boardsLeftWithoutOwner).not.toHaveBeenCalled();
    });
  });

  // BP-832. A deactivated administrator no longer counts towards keeping one
  it("deletes a deactivated administrator while one active one remains", async () => {
    found(person({ role: "admin", deactivatedAt: new Date() }));
    userFindOneAndDelete.mockResolvedValue(person({ role: "admin", deactivatedAt: new Date() }));
    userCountDocuments.mockResolvedValue(1);

    expect((await DELETE(...del(TARGET_HEX))).status).toBe(200);
  });

  it("refuses the only owner of a board, naming every such board", async () => {
    found(person());
    boardsOnlyOwnedBy.mockResolvedValue([
      { _id: "p1", name: "Alpha", key: "AL" },
      { _id: "p2", name: "Beta", key: "BE" },
    ]);

    const res = await DELETE(...del(TARGET_HEX.toUpperCase()));

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe(
      "target is the only owner of Alpha (AL), Beta (BE). Make someone else an owner there before deleting this account."
    );
    expect(body.boards).toHaveLength(2);
    expect(boardsOnlyOwnedBy).toHaveBeenCalledWith(scopedToDefaultTenant(), TARGET_HEX);
    expect(userFindOneAndDelete).not.toHaveBeenCalled();
    expect(grantDeleteMany).not.toHaveBeenCalled();
    expect(revokeUserSessions).not.toHaveBeenCalled();
    expect(logInstanceAudit).not.toHaveBeenCalled();
  });

  it("removes every grant the deleted account held", async () => {
    found(person());

    const res = await DELETE(...del(TARGET_HEX));

    expect(res.status).toBe(200);
    expect(grantDeleteMany).toHaveBeenCalledWith({ subject: TARGET_HEX, tenant: DEFAULT_TENANT_ID });
  });

  // A link left behind would refuse the same person's provider as "already linked" for good (BP-828)
  it("removes every sign-in provider the deleted account had linked", async () => {
    found(person());

    await DELETE(...del(TARGET_HEX));

    expect(identityDeleteMany).toHaveBeenCalledWith({ user: TARGET_HEX, tenant: DEFAULT_TENANT_ID });
  });

  it("leaves the grants alone when the account was not deleted", async () => {
    found(person());
    userFindOneAndDelete.mockResolvedValue(null);

    await DELETE(...del(TARGET_HEX));

    expect(grantDeleteMany).not.toHaveBeenCalled();
  });

  it("deletes the account it was asked about, and ends that account's sessions", async () => {
    found(person());

    const res = await DELETE(...del(TARGET_HEX));

    expect(res.status).toBe(200);
    // Which account, not merely that one was deleted: both of these read an id out of scope, and
    // the caller's own is in the same scope
    expect(userFindOneAndDelete).toHaveBeenCalledWith({ _id: TARGET_HEX, tenant: DEFAULT_TENANT_ID });
    expect(revokeUserSessions).toHaveBeenCalledWith(TARGET_HEX);
  });

  // The fix's own thesis, at the two places it is spent: the document's id is what the delete and
  // the revoke are given, so a request spelled in upper case still acts on the account the
  // database resolved rather than on the string that arrived.
  it("acts on the id the database resolved, not the one that was typed", async () => {
    found(person());

    const res = await DELETE(...del(TARGET_HEX.toUpperCase()));

    expect(res.status).toBe(200);
    expect(userFindOneAndDelete).toHaveBeenCalledWith({ _id: TARGET_HEX, tenant: DEFAULT_TENANT_ID });
    expect(revokeUserSessions).toHaveBeenCalledWith(TARGET_HEX);
  });

  // The refusal its siblings on this route already make. Sharper here than for any of them: this is
  // the one write that cannot be undone, and the only one an unattended credential could make.
  it("refuses a machine credential", async () => {
    getAuthUser.mockResolvedValue({ ...ADMIN_DOC, viaMachineCredential: true });
    found(person());

    const res = await DELETE(...del(TARGET_HEX));

    expect(res.status).toBe(403);
    expect(userFindOneAndDelete).not.toHaveBeenCalled();
    expect(revokeUserSessions).not.toHaveBeenCalled();
  });

  it("refuses the caller their own account", async () => {
    found(person({ _id: ADMIN_HEX, role: "admin" }));

    const res = await DELETE(...del(ADMIN_HEX));

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "Cannot delete yourself" });
    expect(userFindOneAndDelete).not.toHaveBeenCalled();
  });

  // BP-546. The same account, spelled the way BSON also accepts. Comparing the path segment let
  // this through, and with no last-admin guard behind it the instance was left with no
  // administrator and no way to make one.
  it("refuses it in upper case too, because that is the same account", async () => {
    found(person({ _id: ADMIN_HEX, role: "admin" }));

    const res = await DELETE(...del(ADMIN_HEX.toUpperCase()));

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "Cannot delete yourself" });
    expect(userFindOneAndDelete).not.toHaveBeenCalled();
  });

  // The second lock on that door, and unreachable while the first one holds: an admin cannot be
  // looking at the only admin unless they are looking at themselves. It is here because the first
  // lock did not hold, and the state it leaves behind cannot be undone from the product at all.
  it("refuses the last administrator", async () => {
    found(person({ role: "admin" }));
    userCountDocuments.mockResolvedValue(1);

    const res = await DELETE(...del(TARGET_HEX));

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "Cannot delete the last admin" });
    // The filter, because a count of everybody never reaches 1 on an instance that has anybody
    expect(userCountDocuments).toHaveBeenCalledWith({ role: "admin", deactivatedAt: null, tenant: DEFAULT_TENANT_ID });
    expect(userFindOneAndDelete).not.toHaveBeenCalled();
  });

  // The other half of that guard. Without this, `if (user.role === "admin")` could be dropped and
  // every fresh instance — which has exactly one administrator — would refuse to delete any member
  // at all, with the message above.
  it("still deletes a member on an instance with a single administrator", async () => {
    found(person({ role: "member" }));
    userCountDocuments.mockResolvedValue(1);

    const res = await DELETE(...del(TARGET_HEX));

    expect(res.status).toBe(200);
    expect(userFindOneAndDelete).toHaveBeenCalledWith({ _id: TARGET_HEX, tenant: DEFAULT_TENANT_ID });
  });

  it("still deletes an admin while another one remains, and says so in the row", async () => {
    found(person({ role: "admin" }));
    userCountDocuments.mockResolvedValue(2);

    const res = await DELETE(...del(TARGET_HEX));

    expect(res.status).toBe(200);
    expect(userFindOneAndDelete).toHaveBeenCalled();
    // Which kind of account it was, because that is the half of "who was deleted" the username
    // does not answer
    expect(logInstanceAudit).toHaveBeenCalledWith(
      scopedToDefaultTenant(),
      expect.objectContaining({ action: "user_deleted", detail: "an administrator" })
    );
  });

  // A machine's account is not a person. The Users list does not offer one, and deleting it takes
  // the fleet's identity with it — every worker call then fails with "no identity yet".
  it("refuses a machine account", async () => {
    found(person({ kind: "machine" }));

    const res = await DELETE(...del(TARGET_HEX));

    expect(res.status).toBe(400);
    // The wording, because it is what the screen shows the person who tried: these two refusals
    // are otherwise interchangeable and mean entirely different things
    expect(await res.json()).toMatchObject({
      error: "A machine account is released under Settings → Workers, not deleted here",
    });
    expect(userFindOneAndDelete).not.toHaveBeenCalled();
  });

  // Load first, refuse second: it is what makes a 404 mean the account is not there rather than
  // "it was there a moment ago and has just gone".
  it("answers 404 for an account that is not there, without deleting anything", async () => {
    found(null);

    const res = await DELETE(...del(TARGET_HEX));

    expect(res.status).toBe(404);
    expect(userFindOneAndDelete).not.toHaveBeenCalled();
    expect(revokeUserSessions).not.toHaveBeenCalled();
  });

  // The gap between the check and the write. Two administrators on the same account: the loser
  // used to be told they had deleted it, because the delete's own answer was thrown away.
  // BP-538. The account is gone, so this row is the only place it is recorded that it ever existed
  // or who removed it — which is why `target` is the username and not a reference.
  it("records the deletion, naming the account and who did it", async () => {
    found(person({ role: "member" }));

    await DELETE(...del(TARGET_HEX));

    expect(logInstanceAudit).toHaveBeenCalledWith(scopedToDefaultTenant(), {
      action: "user_deleted",
      user: ADMIN_HEX,
      actorUsername: "owner",
      target: "target",
      detail: "a member",
    });
  });

  // Why the row goes in before the revoke rather than after it, as the password path does: by this
  // point the account is already gone, so a revoke that throws must not take the record with it.
  it("records the deletion even if ending the sessions fails", async () => {
    found(person());
    revokeUserSessions.mockRejectedValueOnce(new Error("mongo is away"));

    await expect(DELETE(...del(TARGET_HEX))).rejects.toThrow();

    expect(logInstanceAudit).toHaveBeenCalledWith(
      scopedToDefaultTenant(),
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
    userFindOneAndDelete.mockResolvedValue(null);

    const res = await DELETE(...del(TARGET_HEX));

    expect(res.status).toBe(404);
    expect(revokeUserSessions).not.toHaveBeenCalled();
    // Nor a row about a deletion that did not happen: the log goes in after the delete's own answer
    expect(logInstanceAudit).not.toHaveBeenCalled();
  });

  // An id that is not an id: `findById` rejects with a CastError, which used to leave this handler
  // as a 500 about nothing. The same answer a wrong guess gets, so neither says which ids exist.
  it("answers 404 for an id that is not an id, rather than throwing", async () => {
    const res = await DELETE(...del("not-an-object-id"));

    expect(res.status).toBe(404);
    expect(userFindOne).not.toHaveBeenCalled();
  });

  // The order of the first two, which is the difference between "you may not ask" and an answer
  // about who exists: a machine credential is refused before the account is looked up.
  it("refuses a machine credential before it says whether the account exists", async () => {
    getAuthUser.mockResolvedValue({ ...ADMIN_DOC, viaMachineCredential: true });
    found(null);

    const res = await DELETE(...del(TARGET_HEX));

    expect(res.status).toBe(403);
    expect(userFindOne).not.toHaveBeenCalled();
  });
});

/**
 * The precedent the DELETE guards are built on, and neither half of it had a test.
 */
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
    expect(userUpdateOne).toHaveBeenCalledWith(
      { _id: "target-1", role: "admin", tenant: DEFAULT_TENANT_ID },
      { $set: { role: "member" } }
    );
    // Already written: the save must not write it again over a promotion landing in between
    expect(target.unmarkModified).toHaveBeenCalledWith("role");
    expect(target.unmarkModified.mock.invocationCallOrder[0]).toBeLessThan(target.save.mock.invocationCallOrder[0]);
  });

  // BP-841. The other administrator was demoted or deactivated by a request that counted this one
  it("puts the role back, and saves nothing, when its demotion left no active admin", async () => {
    const target = targetDoc({ role: "admin" });
    found(target);
    userCountDocuments.mockResolvedValueOnce(2).mockResolvedValueOnce(0);

    const res = await PUT(put({ role: "member", email: "new@example.com" }), ctx());

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "Cannot demote the last admin" });
    expect(userCountDocuments).toHaveBeenLastCalledWith({
      role: "admin",
      deactivatedAt: null,
      tenant: DEFAULT_TENANT_ID,
    });
    expect(userUpdateOne).toHaveBeenLastCalledWith(
      { _id: "target-1", tenant: DEFAULT_TENANT_ID },
      { $set: { role: "admin" } }
    );
    expect(target.save).not.toHaveBeenCalled();
    expect(logInstanceAudit).not.toHaveBeenCalled();
  });

  it("takes its demotion back when the same request is then refused for the address", async () => {
    const target = targetDoc({ role: "admin" });
    target.save.mockRejectedValue(Object.assign(new Error("dup"), { code: 11000, keyPattern: { email: 1 } }));
    found(target);

    const res = await PUT(put({ role: "member", email: "taken@example.com" }), ctx());

    expect(res.status).toBe(409);
    expect(userUpdateOne).toHaveBeenLastCalledWith(
      { _id: "target-1", role: "member", tenant: DEFAULT_TENANT_ID },
      { $set: { role: "admin" } }
    );
    expect(logInstanceAudit).not.toHaveBeenCalledWith(scopedToDefaultTenant(), expect.objectContaining({ action: "user_role_changed" }));
  });

  it("takes its demotion back when the save fails outright", async () => {
    const target = targetDoc({ role: "admin" });
    target.save.mockRejectedValue(new Error("db down"));
    found(target);

    await expect(PUT(put({ role: "member" }), ctx())).rejects.toThrow("db down");
    expect(userUpdateOne).toHaveBeenLastCalledWith(
      { _id: "target-1", role: "member", tenant: DEFAULT_TENANT_ID },
      { $set: { role: "admin" } }
    );
  });

  it("records no second change of role when a racing request demoted them first", async () => {
    const target = targetDoc({ role: "admin" });
    found(target);
    userUpdateOne.mockResolvedValue({ modifiedCount: 0 });

    expect((await PUT(put({ role: "member" }), ctx())).status).toBe(200);
    expect(logInstanceAudit).not.toHaveBeenCalledWith(scopedToDefaultTenant(), expect.objectContaining({ action: "user_role_changed" }));
  });

  it("counts nothing again when its own conditional write changed nothing", async () => {
    const target = targetDoc({ role: "admin" });
    found(target);
    userUpdateOne.mockResolvedValue({ modifiedCount: 0 });
    userCountDocuments.mockResolvedValue(2);

    expect((await PUT(put({ role: "member" }), ctx())).status).toBe(200);
    expect(userCountDocuments).toHaveBeenCalledTimes(1);
  });

  // Not the same refusal: this one is about the caller, and it fires however many admins there are
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

describe("with password sign-in off (BP-830)", () => {
  beforeEach(() => {
    process.env.PASSWORD_SIGN_IN = "off";
  });
  afterEach(() => {
    delete process.env.PASSWORD_SIGN_IN;
  });
  it("lets an administrator set no password, and changes nothing else in that request", async () => {
    const target = targetDoc({ role: "member" });
    found(target);

    const res = await PUT(put({ password: "a-fresh-password", role: "admin" }), ctx());

    expect(res.status).toBe(403);
    expect(target.save).not.toHaveBeenCalled();
    expect(revokeUserCredentials).not.toHaveBeenCalled();
  });
});

// BP-830. An administrator's answers to "I cannot get in" and "somebody else did" that need no
// password, so they still work once password sign-in is off
describe("PUT /api/users/:id — account actions", () => {
  it("confirms an address, so a provider can sign them in by it, and records who did", async () => {
    const target = targetDoc({ emailVerifiedAt: null });
    found(target);

    const res = await PUT(put({ confirmEmail: true }), ctx());

    expect(res.status).toBe(200);
    expect(target.emailVerifiedAt).toBeInstanceOf(Date);
    expect(target.save).toHaveBeenCalled();
    expect(logInstanceAudit).toHaveBeenCalledWith(
      scopedToDefaultTenant(),
      expect.objectContaining({ action: "user_email_confirmed", user: "admin-1", target: "target" })
    );
  });

  it.each([
    [{ confirmEmail: true, signOutEverywhere: true }],
    [{ signOutEverywhere: true, role: "member" }],
    [{ confirmEmail: true, email: "elsewhere@example.com" }],
  ])("refuses %j rather than doing part of it", async (body) => {
    const target = targetDoc({ emailVerifiedAt: null });
    found(target);

    expect((await PUT(put(body), ctx())).status).toBe(400);
    expect(target.save).not.toHaveBeenCalled();
    expect(revokeUserCredentials).not.toHaveBeenCalled();
  });

  it("refuses to confirm an account with no address", async () => {
    const target = targetDoc({ email: "", emailVerifiedAt: null });
    found(target);

    expect((await PUT(put({ confirmEmail: true }), ctx())).status).toBe(400);
    expect(target.save).not.toHaveBeenCalled();
  });

  it("signs somebody out everywhere, unlinking their providers, with passwords on or off", async () => {
    found(targetDoc());
    revokeUserCredentials.mockResolvedValue({ identitiesUnlinked: 2 });
    process.env.PASSWORD_SIGN_IN = "off";

    try {
      const res = await PUT(put({ signOutEverywhere: true }), ctx());

      expect(res.status).toBe(200);
      expect(revokeUserCredentials).toHaveBeenCalledWith("target-1");
      expect(invalidateResetTokens).toHaveBeenCalledWith(scopedToDefaultTenant(), "target-1");
      expect(logInstanceAudit).toHaveBeenCalledWith(
        scopedToDefaultTenant(),
        expect.objectContaining({ action: "user_signed_out_everywhere", user: "admin-1", target: "target" })
      );
    } finally {
      delete process.env.PASSWORD_SIGN_IN;
    }
  });

  it.each([
    ["on your own account", () => found(targetDoc({ _id: "admin-1" })), {}],
    ["on a machine account", () => found(targetDoc({ kind: "machine" })), {}],
    ["from a machine credential", () => found(targetDoc()), { viaMachineCredential: true }],
  ])("refuses %s", async (_label, arrange, caller) => {
    arrange();
    getAuthUser.mockResolvedValue({ ...ADMIN, ...caller });

    for (const action of [{ confirmEmail: true }, { signOutEverywhere: true }]) {
      expect((await PUT(put(action), ctx())).status).toBeGreaterThanOrEqual(400);
    }
    expect(revokeUserCredentials).not.toHaveBeenCalled();
  });
});

// BP-832. Deactivation keeps the account and its history, and ends everything it can sign in with
describe("PUT /api/users/:id — deactivating and reactivating", () => {
  it("deactivates, revoking every credential but the providers, and records who did", async () => {
    const target = targetDoc({ role: "member", deactivatedAt: null });
    found(target);

    const res = await PUT(put({ deactivate: true }), ctx());

    expect(res.status).toBe(200);
    expect(target.deactivatedAt).toBeInstanceOf(Date);
    expect(target.save).toHaveBeenCalled();
    expect(revokeUserCredentials).toHaveBeenCalledWith("target-1", null, { keepIdentities: true });
    expect(invalidateResetTokens).toHaveBeenCalledWith(scopedToDefaultTenant(), "target-1");
    expect(logInstanceAudit).toHaveBeenCalledWith(
      scopedToDefaultTenant(),
      expect.objectContaining({ action: "user_deactivated", user: "admin-1", target: "target" })
    );
  });

  // Two administrators deactivating each other at once each counted the other as still active
  it("takes it back when no active administrator is left after all", async () => {
    const target = targetDoc({ role: "admin", deactivatedAt: null });
    found(target);
    userCountDocuments.mockResolvedValueOnce(2).mockResolvedValueOnce(0);

    const res = await PUT(put({ deactivate: true }), ctx());

    expect(res.status).toBe(409);
    expect(target.deactivatedAt).toBeNull();
    expect(target.save).toHaveBeenCalledTimes(2);
    expect(revokeUserCredentials).not.toHaveBeenCalled();
  });

  // Two co-owners of a board deactivating each other at once each counted the other as active
  it("takes it back when a board it owned is left with no active owner", async () => {
    const target = targetDoc({ role: "member", deactivatedAt: null });
    found(target);
    boardsLeftWithoutOwner.mockResolvedValueOnce(["p1"]);

    const res = await PUT(put({ deactivate: true }), ctx());

    expect(res.status).toBe(409);
    expect(target.deactivatedAt).toBeNull();
    expect(revokeUserCredentials).not.toHaveBeenCalled();
  });

  it("refuses the last administrator who can still act", async () => {
    const target = targetDoc({ role: "admin", deactivatedAt: null });
    found(target);
    userCountDocuments.mockResolvedValue(1);

    expect((await PUT(put({ deactivate: true }), ctx())).status).toBe(400);
    expect(userCountDocuments).toHaveBeenCalledWith({ role: "admin", deactivatedAt: null, tenant: DEFAULT_TENANT_ID });
    expect(target.save).not.toHaveBeenCalled();
    expect(revokeUserCredentials).not.toHaveBeenCalled();
  });

  it("refuses your own account and a machine's", async () => {
    found(targetDoc({ _id: "admin-1" }));
    expect((await PUT(put({ deactivate: true }), ctx())).status).toBe(400);

    found(targetDoc({ kind: "machine" }));
    expect((await PUT(put({ deactivate: true }), ctx())).status).toBe(400);
    expect(revokeUserCredentials).not.toHaveBeenCalled();
  });

  it("reactivates, bringing back sign-in and none of the revoked credentials", async () => {
    const target = targetDoc({ role: "member", deactivatedAt: new Date() });
    found(target);

    const res = await PUT(put({ reactivate: true }), ctx());

    expect(res.status).toBe(200);
    expect(target.deactivatedAt).toBeNull();
    // Only what was minted between the flag and the first revoke: providers stay, nothing returns
    expect(revokeUserCredentials).toHaveBeenCalledWith("target-1", null, { keepIdentities: true });
    expect(logInstanceAudit).toHaveBeenCalledWith(scopedToDefaultTenant(), expect.objectContaining({ action: "user_reactivated" }));
  });

  it("sets no password on a deactivated account, which would unlink the providers it keeps", async () => {
    const target = targetDoc({ role: "member", deactivatedAt: new Date() });
    found(target);

    expect((await PUT(put({ password: "a-fresh-password" }), ctx())).status).toBe(400);
    expect(target.save).not.toHaveBeenCalled();
    expect(revokeUserCredentials).not.toHaveBeenCalled();
  });

  it("does not sign out a deactivated account, which would only unlink the providers it keeps", async () => {
    found(targetDoc({ role: "member", deactivatedAt: new Date() }));

    expect((await PUT(put({ signOutEverywhere: true }), ctx())).status).toBe(400);
    expect(revokeUserCredentials).not.toHaveBeenCalled();
  });

  it("counts only administrators who can still act as the last one standing", async () => {
    found(targetDoc({ role: "admin" }));
    userCountDocuments.mockResolvedValue(1);

    expect((await PUT(put({ role: "member" }), ctx())).status).toBe(400);
    expect(userCountDocuments).toHaveBeenCalledWith({ role: "admin", deactivatedAt: null, tenant: DEFAULT_TENANT_ID });
  });
});

describe("PUT /api/users/:id — deactivated administrators and board owners (BP-832)", () => {
  it("demotes a deactivated administrator while one active one remains", async () => {
    found(targetDoc({ role: "admin", deactivatedAt: new Date() }));
    userCountDocuments.mockResolvedValue(1);

    expect((await PUT(put({ role: "member" }), ctx())).status).toBe(200);
  });

  // The rule deleting keeps: a board owned only by somebody who can do nothing is one nobody runs
  it("refuses to deactivate the only owner of a board, naming it", async () => {
    const target = targetDoc({ role: "member" });
    found(target);
    boardsOnlyOwnedBy.mockResolvedValue([{ _id: "p1", name: "Alpha", key: "AL" }]);

    const res = await PUT(put({ deactivate: true }), ctx());

    expect(res.status).toBe(409);
    expect((await res.json()).error).toContain("Alpha (AL)");
    expect(target.save).not.toHaveBeenCalled();
    expect(revokeUserCredentials).not.toHaveBeenCalled();
  });
});
