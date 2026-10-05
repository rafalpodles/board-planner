import { describe, it, expect, vi, beforeEach } from "vitest";
import { DEFAULT_ORGANISATION_ID } from "@/lib/organisation-field";

const getAuthUser = vi.fn();
const findOneAndUpdate = vi.fn();
const updateMany = vi.fn();

const READER = "507f1f77bcf86cd799439011";
const ROW = "69a52e3b399b27d3cbb2c5a5";

vi.mock("@/lib/auth", () => ({ getAuthUser }));
vi.mock("@/lib/db", () => ({ connectDB: vi.fn() }));
vi.mock("@/models/notification", () => ({
  Notification: {
    findOneAndUpdate: (...a: unknown[]) => findOneAndUpdate(...a),
    updateMany: (...a: unknown[]) => updateMany(...a),
  },
}));

const { PATCH } = await import("./route");

const noParams = { params: Promise.resolve({}) };

const request = (body: unknown) =>
  new Request("https://app.example.com/api/notifications/read", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

describe("PATCH /api/notifications/read", () => {
  beforeEach(() => {
    // Braced, not an arrow returning the reset: vitest treats a returned function as teardown and
    // would call the mock after every test.
    getAuthUser.mockReset();
    findOneAndUpdate.mockReset();
    updateMany.mockReset();
    getAuthUser.mockImplementation(async () => ({ _id: READER, role: "member" }));
  });

  it("marks one row read, scoped to the reader and to what the bell showed", async () => {
    const res = await PATCH(request({ id: ROW }), noParams);

    expect(res.status).toBe(200);
    expect(findOneAndUpdate.mock.calls[0][0]).toEqual({
      _id: ROW,
      recipient: READER,
      inApp: { $ne: false },
      organisation: DEFAULT_ORGANISATION_ID,
    });
    expect(updateMany).not.toHaveBeenCalled();
  });

  // The list narrows to the token's boards, so clearing the bell must not reach past them: the other boards'
  // rows would be marked read without ever having been shown, and dropped from tomorrow's digest
  it("clears only the boards a limited token reaches, for one row and for all", async () => {
    getAuthUser.mockImplementation(async () => ({ _id: READER, role: "member", tokenScope: ["board-a"] }));

    await PATCH(request({ id: ROW }), noParams);
    await PATCH(request({}), noParams);

    expect(findOneAndUpdate.mock.calls[0][0]).toMatchObject({ project: { $in: ["board-a"] } });
    expect(updateMany.mock.calls[0][0]).toMatchObject({ read: false, project: { $in: ["board-a"] } });
  });

  it("does not narrow a person's own session", async () => {
    await PATCH(request({}), noParams);

    expect(updateMany.mock.calls[0][0]).not.toHaveProperty("project");
  });

  it("marks everything unread read when no id is named", async () => {
    const res = await PATCH(request({}), noParams);

    expect(res.status).toBe(200);
    expect(updateMany.mock.calls[0][0]).toEqual({
      recipient: READER,
      read: false,
      inApp: { $ne: false },
      organisation: DEFAULT_ORGANISATION_ID,
    });
    expect(findOneAndUpdate).not.toHaveBeenCalled();
  });

  // BP-433. `id` reached the query uncast: an object picked an arbitrary row of the caller's own,
  // and a string that is not an id threw a CastError out of the route as a 500.
  it.each([
    ["an operator object", { $ne: null }],
    ["a string that is not an id", "nope"],
    ["a number", 7],
    // Falsy, and therefore the pair that a `if (id)` branch check would wave through into a
    // mark-all — silently reading every row the caller has instead of the one they named.
    ["an empty string", ""],
    ["null", null],
  ])("refuses %s rather than querying with it", async (_label, id) => {
    const res = await PATCH(request({ id }), noParams);

    expect(res.status).toBe(400);
    // The refusal has to happen before the query, not instead of its result: a route that queried
    // and then answered 400 would still have written.
    expect(findOneAndUpdate).not.toHaveBeenCalled();
    expect(updateMany).not.toHaveBeenCalled();
  });

  // The control for the refusals above: without it, "nothing was queried" equally describes a
  // route that refuses everything, and the mark-all branch is one edit away from being one.
  it("still reaches the mark-all branch for a body carrying no id at all", async () => {
    await PATCH(request({ somethingElse: true }), noParams);

    expect(updateMany).toHaveBeenCalledTimes(1);
  });
});
