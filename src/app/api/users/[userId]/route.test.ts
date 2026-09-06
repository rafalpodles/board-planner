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
    expect(target.kind).toBe("human");
    expect(target.save).toHaveBeenCalled();
  });

  it("leaves the address alone when the body does not carry one", async () => {
    const target = targetDoc();
    found(target);

    await PUT(put({ role: "member" }), ctx());

    expect(target.email).toBe("target@example.com");
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
    expect(revokeUserSessions).not.toHaveBeenCalled();
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
    expect(revokeUserSessions).toHaveBeenCalledWith("target-1");
    // A reset link already in their inbox would otherwise still overwrite what the admin just set
    expect(invalidateResetTokens).toHaveBeenCalledWith("target-1");
    // The actor, not just the subject: a log naming the target as the one who acted is worse than
    // no log, because it reads as a confession by the wrong person
    expect(logInstanceAudit).toHaveBeenCalledWith(
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
    expect(revokeUserSessions).not.toHaveBeenCalled();
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
    revokeUserSessions.mockRejectedValueOnce(new Error("mongo is having a moment"));

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
    expect(revokeUserSessions).not.toHaveBeenCalled();
    expect(logInstanceAudit).toHaveBeenCalledTimes(1);
    expect(logInstanceAudit).toHaveBeenCalledWith({
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
    userFindByIdAndDelete.mockResolvedValue(person());
  });

  it("deletes the account it was asked about, and ends that account's sessions", async () => {
    found(person());

    const res = await DELETE(...del(TARGET_HEX));

    expect(res.status).toBe(200);
    // Which account, not merely that one was deleted: both of these read an id out of scope, and
    // the caller's own is in the same scope
    expect(userFindByIdAndDelete).toHaveBeenCalledWith(TARGET_HEX);
    expect(revokeUserSessions).toHaveBeenCalledWith(TARGET_HEX);
  });

  // The fix's own thesis, at the two places it is spent: the document's id is what the delete and
  // the revoke are given, so a request spelled in upper case still acts on the account the
  // database resolved rather than on the string that arrived.
  it("acts on the id the database resolved, not the one that was typed", async () => {
    found(person());

    const res = await DELETE(...del(TARGET_HEX.toUpperCase()));

    expect(res.status).toBe(200);
    expect(userFindByIdAndDelete).toHaveBeenCalledWith(TARGET_HEX);
    expect(revokeUserSessions).toHaveBeenCalledWith(TARGET_HEX);
  });

  // The refusal its siblings on this route already make. Sharper here than for any of them: this is
  // the one write that cannot be undone, and the only one an unattended credential could make.
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

  // BP-546. The same account, spelled the way BSON also accepts. Comparing the path segment let
  // this through, and with no last-admin guard behind it the instance was left with no
  // administrator and no way to make one.
  it("refuses it in upper case too, because that is the same account", async () => {
    found(person({ _id: ADMIN_HEX, role: "admin" }));

    const res = await DELETE(...del(ADMIN_HEX.toUpperCase()));

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "Cannot delete yourself" });
    expect(userFindByIdAndDelete).not.toHaveBeenCalled();
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
    expect(userCountDocuments).toHaveBeenCalledWith({ role: "admin" });
    expect(userFindByIdAndDelete).not.toHaveBeenCalled();
  });

  // The other half of that guard. Without this, `if (user.role === "admin")` could be dropped and
  // every fresh instance — which has exactly one administrator — would refuse to delete any member
  // at all, with the message above.
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
    // Which kind of account it was, because that is the half of "who was deleted" the username
    // does not answer
    expect(logInstanceAudit).toHaveBeenCalledWith(
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
    expect(userFindByIdAndDelete).not.toHaveBeenCalled();
  });

  // Load first, refuse second: it is what makes a 404 mean the account is not there rather than
  // "it was there a moment ago and has just gone".
  it("answers 404 for an account that is not there, without deleting anything", async () => {
    found(null);

    const res = await DELETE(...del(TARGET_HEX));

    expect(res.status).toBe(404);
    expect(userFindByIdAndDelete).not.toHaveBeenCalled();
    expect(revokeUserSessions).not.toHaveBeenCalled();
  });

  // The gap between the check and the write. Two administrators on the same account: the loser
  // used to be told they had deleted it, because the delete's own answer was thrown away.
  // BP-538. The account is gone, so this row is the only place it is recorded that it ever existed
  // or who removed it — which is why `target` is the username and not a reference.
  it("records the deletion, naming the account and who did it", async () => {
    found(person({ role: "member" }));

    await DELETE(...del(TARGET_HEX));

    expect(logInstanceAudit).toHaveBeenCalledWith({
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
    // Nor a row about a deletion that did not happen: the log goes in after the delete's own answer
    expect(logInstanceAudit).not.toHaveBeenCalled();
  });

  // An id that is not an id: `findById` rejects with a CastError, which used to leave this handler
  // as a 500 about nothing. The same answer a wrong guess gets, so neither says which ids exist.
  it("answers 404 for an id that is not an id, rather than throwing", async () => {
    const res = await DELETE(...del("not-an-object-id"));

    expect(res.status).toBe(404);
    expect(userFindById).not.toHaveBeenCalled();
  });

  // The order of the first two, which is the difference between "you may not ask" and an answer
  // about who exists: a machine credential is refused before the account is looked up.
  it("refuses a machine credential before it says whether the account exists", async () => {
    getAuthUser.mockResolvedValue({ ...ADMIN_DOC, viaMachineCredential: true });
    found(null);

    const res = await DELETE(...del(TARGET_HEX));

    expect(res.status).toBe(403);
    expect(userFindById).not.toHaveBeenCalled();
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
