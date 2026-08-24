import { describe, it, expect, vi, beforeEach } from "vitest";

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

// Not JSON.stringify on a plain object: `{ $ne: null }` is exactly the shape this route has to
// refuse, and a body built by the test the way a caller would build it is the only way to send it.
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
    });
    expect(updateMany).not.toHaveBeenCalled();
  });

  it("marks everything unread read when no id is named", async () => {
    const res = await PATCH(request({}), noParams);

    expect(res.status).toBe(200);
    expect(updateMany.mock.calls[0][0]).toEqual({
      recipient: READER,
      read: false,
      inApp: { $ne: false },
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

  // The control for the three above. Without it, "nothing was queried" also describes a route
  // that refuses everything, and the mark-all branch is one `id !== undefined` away from that.
  it("still reaches the mark-all branch for a body carrying no id at all", async () => {
    await PATCH(request({ somethingElse: true }), noParams);

    expect(updateMany).toHaveBeenCalledTimes(1);
  });
});
