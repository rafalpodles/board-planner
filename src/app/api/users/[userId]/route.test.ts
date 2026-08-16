import { describe, it, expect, vi, beforeEach } from "vitest";

const getAuthUser = vi.fn();
const check = vi.fn();
const userFindById = vi.fn();
const userCountDocuments = vi.fn();
const userExists = vi.fn();
const revokeUserSessions = vi.fn();
const logInstanceAudit = vi.fn();
const hash = vi.fn();

vi.mock("@/lib/db", () => ({ connectDB: vi.fn() }));
vi.mock("@/lib/auth", () => ({
  getAuthUser,
  RateLimitError: class RateLimitError extends Error {},
  PASSWORD_COST_FACTOR: 10,
  MIN_PASSWORD_LENGTH: 8,
}));
vi.mock("@/lib/grants", () => ({ check, accessibleProjectIds: vi.fn() }));
vi.mock("@/lib/session", () => ({ revokeUserSessions }));
vi.mock("@/lib/instanceAudit", () => ({ logInstanceAudit }));
vi.mock("bcryptjs", () => ({ default: { hash } }));
vi.mock("@/models/user", () => ({
  User: {
    findById: userFindById,
    countDocuments: userCountDocuments,
    exists: userExists,
    findByIdAndDelete: vi.fn(),
  },
}));

const { PUT } = await import("./route");

const ADMIN = { _id: "admin-1", role: "admin" };

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

beforeEach(() => {
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

    const res = await PUT(put({ email: "taken@example.com" }), ctx());

    expect(res.status).toBe(409);
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
    // The actor, not just the subject: a log naming the target as the one who acted is worse than
    // no log, because it reads as a confession by the wrong person
    expect(logInstanceAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "user_password_reset",
        target: "target",
        user: "admin-1",
      })
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

  // The revoke and the audit hang off a flag; a role-only edit must not trip either
  it("leaves sessions and the audit log alone when only the role changes", async () => {
    const target = targetDoc({ role: "member" });
    found(target);

    const res = await PUT(put({ role: "admin" }), ctx());

    expect(res.status).toBe(200);
    expect(revokeUserSessions).not.toHaveBeenCalled();
    expect(logInstanceAudit).not.toHaveBeenCalled();
  });
});
