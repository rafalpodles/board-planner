import { describe, it, expect, vi, beforeEach } from "vitest";
import { isValidObjectId } from "mongoose";

const getAuthUser = vi.fn();
const projectFind = vi.fn();
const projectBulkWrite = vi.fn();

vi.mock("@/lib/db", () => ({ connectDB: vi.fn() }));
vi.mock("@/lib/auth", () => ({ getAuthUser, RateLimitError: class extends Error {} }));
vi.mock("@/models/project", () => ({
  Project: { find: projectFind, bulkWrite: projectBulkWrite },
}));

const { PUT } = await import("./route");

const A = "507f1f77bcf86cd799439011";
const B = "507f1f77bcf86cd799439012";
const C = "507f1f77bcf86cd799439013";

function put(body: unknown) {
  return PUT(
    new Request("http://localhost/api/projects/reorder", {
      method: "PUT",
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({}) }
  );
}

/**
 * Which projects the instance holds.
 *
 * The mock casts like the driver does rather than accepting anything: a malformed id reaching
 * `Project.find` is a CastError, and a stub that quietly answers `[]` instead would let the
 * route's own guard be deleted without a test noticing.
 */
function instanceHolds(...ids: string[]) {
  projectFind.mockImplementation((filter: { _id: { $in: string[] } }) => {
    const asked = filter._id.$in;
    const bad = asked.find((id) => !isValidObjectId(id));
    if (bad !== undefined) {
      throw Object.assign(new Error(`Cast to ObjectId failed for value "${bad}"`), {
        name: "CastError",
      });
    }
    return { select: () => ({ lean: async () => ids.filter((id) => asked.includes(id)).map((_id) => ({ _id })) }) };
  });
}

const sortOrderWrites = () =>
  (projectBulkWrite.mock.calls[0]?.[0] ?? []).map(
    (w: { updateOne: { filter: { _id: string }; update: { $set: { sortOrder: number } } } }) =>
      `${w.updateOne.filter._id}:${w.updateOne.update.$set.sortOrder}`
  );

beforeEach(() => {
  vi.clearAllMocks();
  getAuthUser.mockResolvedValue({ _id: "admin1", role: "admin" });
  instanceHolds(A, B, C);
  projectBulkWrite.mockResolvedValue({});
});

describe("PUT /api/projects/reorder", () => {
  it("writes each id's position as its sortOrder", async () => {
    const res = await put({ order: [C, A, B] });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ updated: 3 });
    expect(sortOrderWrites()).toEqual([`${C}:0`, `${A}:1`, `${B}:2`]);
  });

  // The sidebar order is one list everybody shares, which is why this is instance-level and not
  // a project-admin action (the route's own comment). A member reaching it would reorder the
  // sidebar for every other person on the instance.
  it("is refused for a member, before any write", async () => {
    getAuthUser.mockResolvedValue({ _id: "member1", role: "member" });

    const res = await put({ order: [C, A, B] });

    expect(res.status).toBe(403);
    expect(projectBulkWrite).not.toHaveBeenCalled();
  });

  it("is refused with no credential at all", async () => {
    getAuthUser.mockResolvedValue(null);

    const res = await put({ order: [C, A, B] });

    expect(res.status).toBe(401);
    expect(projectBulkWrite).not.toHaveBeenCalled();
  });

  it("refuses a body whose order is not an array of strings", async () => {
    const res = await put({ order: [A, 7] });

    expect(res.status).toBe(400);
    expect(projectBulkWrite).not.toHaveBeenCalled();
  });

  it("refuses duplicate ids, which would otherwise give one project two positions", async () => {
    const res = await put({ order: [A, B, A] });

    expect(res.status).toBe(400);
    expect(projectBulkWrite).not.toHaveBeenCalled();
  });

  // Scoped by what the instance actually holds: an id the caller invented would otherwise be
  // written as a sortOrder on nothing, and silently consume a position in the sequence.
  it("refuses an id the instance does not hold", async () => {
    instanceHolds(A, B);

    const res = await put({ order: [A, B, C] });

    expect(res.status).toBe(400);
    expect(projectBulkWrite).not.toHaveBeenCalled();
  });

  // An id that is a string but not an ObjectId reached Project.find and threw a CastError, which
  // withAuth rethrows — so a typo answered 500. The sibling task reorder has guarded this since
  // it was written; this route did not.
  it("refuses a malformed id with 400 rather than letting it cast", async () => {
    const res = await put({ order: [A, "not-an-id"] });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "order contains a malformed project id" });
    expect(projectBulkWrite).not.toHaveBeenCalled();
  });

  // Mongoose answers an empty bulkWrite with an empty result rather than throwing, so this is a
  // no-op and not a 500 — worth pinning, because the sibling route guards the same call and the
  // difference between them could otherwise look like an oversight to copy.
  it("accepts an empty order as a no-op", async () => {
    const res = await put({ order: [] });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ updated: 0 });
  });
});
