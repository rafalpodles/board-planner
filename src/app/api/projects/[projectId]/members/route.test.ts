import { describe, it, expect, vi, beforeEach } from "vitest";

const getAuthUser = vi.fn();
const grantFind = vi.fn();
const grantFindLean = vi.fn();
const grantFindOne = vi.fn();
const grantFindOneLean = vi.fn();
const grantUpdateOne = vi.fn();
const grantDeleteOne = vi.fn();
const grantCountDocuments = vi.fn();
const userFind = vi.fn();
const userFindLean = vi.fn();
const userFindById = vi.fn();
const userFindByIdSelect = vi.fn();
const check = vi.fn();
const recipientsWithAccess = vi.fn(async (_ids?: unknown, _project?: unknown): Promise<string[]> => []);
const notificationDeleteMany = vi.fn(async (_filter?: unknown) => ({ deletedCount: 0 }));

vi.mock("@/lib/db", () => ({ connectDB: vi.fn() }));
vi.mock("@/lib/auth", () => ({
  getAuthUser,
  RateLimitError: class RateLimitError extends Error {},
}));
vi.mock("@/lib/grants", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/grants")>();
  return { ...actual, check, accessibleProjectIds: vi.fn(), recipientsWithAccess };
});
vi.mock("@/models/grant", () => ({
  Grant: {
    find: (...a: unknown[]) => (grantFind(...a), { select: () => ({ lean: grantFindLean }) }),
    findOne: (...a: unknown[]) => (grantFindOne(...a), { select: () => ({ lean: grantFindOneLean }) }),
    updateOne: grantUpdateOne,
    deleteOne: grantDeleteOne,
    countDocuments: grantCountDocuments,
  },
}));
vi.mock("@/models/user", () => ({
  User: {
    find: (...a: unknown[]) => (userFind(...a), { select: () => ({ sort: () => ({ lean: userFindLean }) }) }),
    findById: (...a: unknown[]) => (userFindById(...a), { select: userFindByIdSelect }),
  },
}));
vi.mock("@/models/project", () => ({ Project: { findOne: vi.fn() } }));
vi.mock("@/models/task", () => ({ Task: {} }));
vi.mock("@/models/notification", () => ({
  Notification: { deleteMany: (filter: unknown) => notificationDeleteMany(filter) },
}));

const { GET, PUT, DELETE } = await import("./route");

const PROJECT = "69a52e3b399b27d3cbb2c5a5";
const params = Promise.resolve({ projectId: PROJECT });

// Real object ids: PUT rejects anything else before it queries (BP-304)
const U1 = "507f1f77bcf86cd799439011";
const U2 = "507f1f77bcf86cd799439012";
const GHOST = "507f1f77bcf86cd799439013";
const W1 = "507f1f77bcf86cd799439014";

function put(body: unknown) {
  return new Request(`http://x/api/projects/${PROJECT}/members`, {
    method: "PUT",
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  getAuthUser.mockResolvedValue({ _id: "o1", role: "member" });
  check.mockResolvedValue(true);
  grantFindLean.mockResolvedValue([]);
  grantFindOneLean.mockResolvedValue(null);
  userFindLean.mockResolvedValue([]);
  userFindByIdSelect.mockResolvedValue({ _id: "u1", role: "member", kind: "human" });
  grantCountDocuments.mockResolvedValue(2);
  recipientsWithAccess.mockResolvedValue([]);
});

describe("GET members", () => {
  it("labels each user with their relation on this project", async () => {
    userFindLean.mockResolvedValue([
      { _id: "u1", username: "ann", fullName: "Ann", role: "member" },
      { _id: "u2", username: "bo", fullName: "Bo", role: "member" },
    ]);
    grantFindLean.mockResolvedValue([{ subject: "u1", relation: "owner" }]);

    const body = await (await GET(new Request("http://x"), { params })).json();

    expect(body).toEqual([
      { _id: "u1", username: "ann", fullName: "Ann", relation: "owner", instanceAdmin: false },
      { _id: "u2", username: "bo", fullName: "Bo", relation: null, instanceAdmin: false },
    ]);
  });

  it("scopes the grant query to this project", async () => {
    await GET(new Request("http://x"), { params });
    expect(grantFind).toHaveBeenCalledWith({ objectType: "project", object: PROJECT });
  });

  it("never offers worker machine identities as grantable members", async () => {
    await GET(new Request("http://x"), { params });
    expect(userFind).toHaveBeenCalledWith({
      kind: { $ne: "machine" },
      $or: [{ role: "admin" }, { _id: { $in: [] } }],
    });
  });

  it("marks instance admins, who hold no grants", async () => {
    userFindLean.mockResolvedValue([{ _id: "a1", username: "root", fullName: "Root", role: "admin" }]);
    const body = await (await GET(new Request("http://x"), { params })).json();
    expect(body[0]).toMatchObject({ relation: null, instanceAdmin: true });
  });

  it("queries only granted users (plus admins), not every human account", async () => {
    grantFindLean.mockResolvedValue([{ subject: "u1", relation: "member" }]);
    await GET(new Request("http://x"), { params });
    expect(userFind).toHaveBeenCalledWith({
      kind: { $ne: "machine" },
      $or: [{ role: "admin" }, { _id: { $in: ["u1"] } }],
    });
  });
});

describe("PUT members", () => {
  it("upserts one grant for the named user", async () => {
    const res = await PUT(put({ userId: U1, relation: "owner" }), { params });
    expect(res.status).toBe(200);
    expect(grantUpdateOne).toHaveBeenCalledWith(
      { subject: U1, objectType: "project", object: PROJECT },
      { $set: { relation: "owner" }, $setOnInsert: { createdBy: "o1" } },
      { upsert: true }
    );
  });

  it("rejects a relation that is not owner or member", async () => {
    const res = await PUT(put({ userId: U1, relation: "root" }), { params });
    expect(res.status).toBe(400);
    expect(grantUpdateOne).not.toHaveBeenCalled();
  });

  it("refuses anyone who is not an owner of this project", async () => {
    check.mockResolvedValue(false);
    const res = await PUT(put({ userId: U1, relation: "owner" }), { params });
    expect(res.status).toBe(403);
    expect(grantUpdateOne).not.toHaveBeenCalled();
  });

  it("404s when the target user does not exist", async () => {
    userFindByIdSelect.mockResolvedValue(null);
    const res = await PUT(put({ userId: GHOST, relation: "member" }), { params });
    expect(res.status).toBe(404);
    expect(grantUpdateOne).not.toHaveBeenCalled();
  });

  it("404s when the target is a machine identity", async () => {
    userFindByIdSelect.mockResolvedValue({ _id: W1, role: "member", kind: "machine" });
    const res = await PUT(put({ userId: W1, relation: "member" }), { params });
    expect(res.status).toBe(404);
    expect(grantUpdateOne).not.toHaveBeenCalled();
  });

  it("allows granting member to someone who was never an owner, even with only one owner on the board", async () => {
    grantFindOneLean.mockResolvedValue(null);
    grantCountDocuments.mockResolvedValue(1);
    const res = await PUT(put({ userId: U2, relation: "member" }), { params });
    expect(res.status).toBe(200);
    expect(grantUpdateOne).toHaveBeenCalledWith(
      { subject: U2, objectType: "project", object: PROJECT },
      { $set: { relation: "member" }, $setOnInsert: { createdBy: "o1" } },
      { upsert: true }
    );
  });

  it("refuses to demote the last owner", async () => {
    grantFindOneLean.mockResolvedValue({ relation: "owner" });
    grantCountDocuments.mockResolvedValue(1);
    const res = await PUT(put({ userId: U1, relation: "member" }), { params });
    expect(res.status).toBe(409);
    expect(grantFindOne).toHaveBeenCalledWith({ subject: U1, objectType: "project", object: PROJECT });
    expect(grantUpdateOne).not.toHaveBeenCalled();
  });

  it("lets one owner demote another, leaving the board with one owner", async () => {
    grantFindOneLean.mockResolvedValue({ relation: "owner" });
    grantCountDocuments.mockResolvedValue(2);
    const res = await PUT(put({ userId: U2, relation: "member" }), { params });
    expect(res.status).toBe(200);
    expect(grantUpdateOne).toHaveBeenCalledWith(
      { subject: U2, objectType: "project", object: PROJECT },
      { $set: { relation: "member" }, $setOnInsert: { createdBy: "o1" } },
      { upsert: true }
    );
  });

  it("survives a concurrent double submit", async () => {
    grantUpdateOne.mockRejectedValueOnce(Object.assign(new Error("dup"), { code: 11000 }));
    const res = await PUT(put({ userId: U1, relation: "owner" }), { params });
    expect(res.status).toBe(200);
  });

  // BP-304: {"$ne": null} resolved to an arbitrary user, which both sidestepped the
  // machine-account exclusion and wrote over whichever grant row Mongo returned first —
  // on a board with two owners the last-owner guard never fires.
  it("refuses a Mongo operator in place of a userId", async () => {
    const res = await PUT(put({ userId: { $ne: null }, relation: "member" }), { params });
    expect(res.status).toBe(400);
    expect(userFindById).not.toHaveBeenCalled();
    expect(grantUpdateOne).not.toHaveBeenCalled();
  });

  it("refuses a string that is not an object id", async () => {
    const res = await PUT(put({ userId: "not-an-object-id", relation: "member" }), { params });
    expect(res.status).toBe(400);
    expect(grantUpdateOne).not.toHaveBeenCalled();
  });
});

describe("DELETE members", () => {
  it("removes the grant for the named user", async () => {
    const url = `http://x/api/projects/${PROJECT}/members?userId=${U2}`;
    const res = await DELETE(new Request(url, { method: "DELETE" }), { params });
    expect(res.status).toBe(200);
    expect(grantDeleteOne).toHaveBeenCalledWith({
      subject: U2,
      objectType: "project",
      object: PROJECT,
    });
  });

  // BP-546's shape, one route over and found by the review of that fix: the last-owner check
  // compared the raw query value while the stored subject is lower-case hex, so the same id
  // shouted skipped the 409 — and `Grant.deleteOne` cast it back and removed the row, leaving a
  // board with no owner at all.
  it("refuses to remove the last owner however the id is spelled", async () => {
    grantCountDocuments.mockResolvedValue(1);
    grantFindLean.mockResolvedValue([{ subject: U2, relation: "owner" }]);
    const url = `http://x/api/projects/${PROJECT}/members?userId=${U2.toUpperCase()}`;
    const res = await DELETE(new Request(url, { method: "DELETE" }), { params });
    expect(res.status).toBe(409);
    expect(grantDeleteOne).not.toHaveBeenCalled();
  });

  it("refuses to remove the last owner", async () => {
    grantCountDocuments.mockResolvedValue(1);
    grantFindLean.mockResolvedValue([{ subject: U2, relation: "owner" }]);
    const url = `http://x/api/projects/${PROJECT}/members?userId=${U2}`;
    const res = await DELETE(new Request(url, { method: "DELETE" }), { params });
    expect(res.status).toBe(409);
    expect(grantDeleteOne).not.toHaveBeenCalled();
  });

  // BP-328. The watcher rows stay, so a re-add restores the feed; what does not stay is the
  // backlog already addressed to them, which the read filter would otherwise have to keep
  // refusing forever.
  it("clears the pending notifications this board had queued for them", async () => {
    const url = `http://x/api/projects/${PROJECT}/members?userId=${U2}`;
    await DELETE(new Request(url, { method: "DELETE" }), { params });

    expect(notificationDeleteMany).toHaveBeenCalledWith({
      recipient: U2,
      project: PROJECT,
    });
  });

  // Found by an independent security review of this branch. Access is not the same thing as a
  // grant row — an instance admin reaches every board without one — so deleting the grant of
  // somebody whose access comes from `role: "admin"` removes nothing while still emptying their
  // feed. That made the route a repeatable way for a board owner to silence instance oversight.
  it("leaves the backlog of somebody who still reaches the board without a grant", async () => {
    recipientsWithAccess.mockResolvedValue([U2]);
    const url = `http://x/api/projects/${PROJECT}/members?userId=${U2}`;

    const res = await DELETE(new Request(url, { method: "DELETE" }), { params });

    expect(res.status).toBe(200);
    expect(notificationDeleteMany).not.toHaveBeenCalled();
  });

  it("asks whether they still reach the board before clearing anything", async () => {
    const url = `http://x/api/projects/${PROJECT}/members?userId=${U2}`;
    await DELETE(new Request(url, { method: "DELETE" }), { params });

    expect(recipientsWithAccess).toHaveBeenCalledWith([U2], PROJECT);
  });

  it("refuses a userId that is not an object id, rather than throwing a 500", async () => {
    const url = `http://x/api/projects/${PROJECT}/members?userId=not-an-object-id`;

    const res = await DELETE(new Request(url, { method: "DELETE" }), { params });

    expect(res.status).toBe(400);
    expect(grantDeleteOne).not.toHaveBeenCalled();
    expect(notificationDeleteMany).not.toHaveBeenCalled();
  });

  // The grant is already gone by the time this runs, so a failure here must not become a failed
  // response — the caller would be told the removal did not happen when it did.
  it("still reports the removal when it cannot tell whether they keep access", async () => {
    recipientsWithAccess.mockRejectedValue(new Error("no database"));
    const url = `http://x/api/projects/${PROJECT}/members?userId=${U2}`;

    const res = await DELETE(new Request(url, { method: "DELETE" }), { params });

    expect(res.status).toBe(200);
    expect(notificationDeleteMany).not.toHaveBeenCalled();
  });

  it("clears nothing when the removal itself was refused", async () => {
    grantCountDocuments.mockResolvedValue(1);
    grantFindLean.mockResolvedValue([{ subject: U2, relation: "owner" }]);
    const url = `http://x/api/projects/${PROJECT}/members?userId=${U2}`;
    await DELETE(new Request(url, { method: "DELETE" }), { params });

    expect(notificationDeleteMany).not.toHaveBeenCalled();
  });
});
