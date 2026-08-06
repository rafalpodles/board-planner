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

vi.mock("@/lib/db", () => ({ connectDB: vi.fn() }));
vi.mock("@/lib/auth", () => ({
  getAuthUser,
  RateLimitError: class RateLimitError extends Error {},
}));
vi.mock("@/lib/grants", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/grants")>();
  return { ...actual, check, accessibleProjectIds: vi.fn() };
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

const { GET, PUT, DELETE } = await import("./route");

const PROJECT = "69a52e3b399b27d3cbb2c5a5";
const params = Promise.resolve({ projectId: PROJECT });

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
    expect(userFind).toHaveBeenCalledWith({ kind: { $ne: "machine" } });
  });

  it("marks instance admins, who hold no grants", async () => {
    userFindLean.mockResolvedValue([{ _id: "a1", username: "root", fullName: "Root", role: "admin" }]);
    const body = await (await GET(new Request("http://x"), { params })).json();
    expect(body[0]).toMatchObject({ relation: null, instanceAdmin: true });
  });
});

describe("PUT members", () => {
  it("upserts one grant for the named user", async () => {
    const res = await PUT(put({ userId: "u1", relation: "owner" }), { params });
    expect(res.status).toBe(200);
    expect(grantUpdateOne).toHaveBeenCalledWith(
      { subject: "u1", objectType: "project", object: PROJECT },
      { $set: { relation: "owner" }, $setOnInsert: { createdBy: "o1" } },
      { upsert: true }
    );
  });

  it("rejects a relation that is not owner or member", async () => {
    const res = await PUT(put({ userId: "u1", relation: "root" }), { params });
    expect(res.status).toBe(400);
    expect(grantUpdateOne).not.toHaveBeenCalled();
  });

  it("refuses anyone who is not an owner of this project", async () => {
    check.mockResolvedValue(false);
    const res = await PUT(put({ userId: "u1", relation: "owner" }), { params });
    expect(res.status).toBe(403);
    expect(grantUpdateOne).not.toHaveBeenCalled();
  });

  it("404s when the target user does not exist", async () => {
    userFindByIdSelect.mockResolvedValue(null);
    const res = await PUT(put({ userId: "ghost", relation: "member" }), { params });
    expect(res.status).toBe(404);
    expect(grantUpdateOne).not.toHaveBeenCalled();
  });

  it("404s when the target is a machine identity", async () => {
    userFindByIdSelect.mockResolvedValue({ _id: "w1", role: "member", kind: "machine" });
    const res = await PUT(put({ userId: "w1", relation: "member" }), { params });
    expect(res.status).toBe(404);
    expect(grantUpdateOne).not.toHaveBeenCalled();
  });

  it("allows granting member to someone who was never an owner, even with only one owner on the board", async () => {
    grantFindOneLean.mockResolvedValue(null);
    grantCountDocuments.mockResolvedValue(1);
    const res = await PUT(put({ userId: "u2", relation: "member" }), { params });
    expect(res.status).toBe(200);
    expect(grantUpdateOne).toHaveBeenCalledWith(
      { subject: "u2", objectType: "project", object: PROJECT },
      { $set: { relation: "member" }, $setOnInsert: { createdBy: "o1" } },
      { upsert: true }
    );
  });

  it("refuses to demote the last owner", async () => {
    grantFindOneLean.mockResolvedValue({ relation: "owner" });
    grantCountDocuments.mockResolvedValue(1);
    const res = await PUT(put({ userId: "u1", relation: "member" }), { params });
    expect(res.status).toBe(409);
    expect(grantFindOne).toHaveBeenCalledWith({ subject: "u1", objectType: "project", object: PROJECT });
    expect(grantUpdateOne).not.toHaveBeenCalled();
  });

  it("lets one owner demote another, leaving the board with one owner", async () => {
    grantFindOneLean.mockResolvedValue({ relation: "owner" });
    grantCountDocuments.mockResolvedValue(2);
    const res = await PUT(put({ userId: "u2", relation: "member" }), { params });
    expect(res.status).toBe(200);
    expect(grantUpdateOne).toHaveBeenCalledWith(
      { subject: "u2", objectType: "project", object: PROJECT },
      { $set: { relation: "member" }, $setOnInsert: { createdBy: "o1" } },
      { upsert: true }
    );
  });

  it("survives a concurrent double submit", async () => {
    grantUpdateOne.mockRejectedValueOnce(Object.assign(new Error("dup"), { code: 11000 }));
    const res = await PUT(put({ userId: "u1", relation: "owner" }), { params });
    expect(res.status).toBe(200);
  });
});

describe("DELETE members", () => {
  it("removes the grant for the named user", async () => {
    const url = `http://x/api/projects/${PROJECT}/members?userId=u2`;
    const res = await DELETE(new Request(url, { method: "DELETE" }), { params });
    expect(res.status).toBe(200);
    expect(grantDeleteOne).toHaveBeenCalledWith({
      subject: "u2",
      objectType: "project",
      object: PROJECT,
    });
  });

  it("refuses to remove the last owner", async () => {
    grantCountDocuments.mockResolvedValue(1);
    grantFindLean.mockResolvedValue([{ subject: "u2", relation: "owner" }]);
    const url = `http://x/api/projects/${PROJECT}/members?userId=u2`;
    const res = await DELETE(new Request(url, { method: "DELETE" }), { params });
    expect(res.status).toBe(409);
    expect(grantDeleteOne).not.toHaveBeenCalled();
  });
});
