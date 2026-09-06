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

const request = (body: unknown) =>
  new Request("https://app.example.com/api/notifications/read", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

describe("PATCH /api/notifications/read", () => {
  beforeEach(() => {
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

  it.each([
    ["an operator object", { $ne: null }],
    ["a string that is not an id", "nope"],
    ["a number", 7],
    ["an empty string", ""],
    ["null", null],
  ])("refuses %s rather than querying with it", async (_label, id) => {
    const res = await PATCH(request({ id }), noParams);

    expect(res.status).toBe(400);
    expect(findOneAndUpdate).not.toHaveBeenCalled();
    expect(updateMany).not.toHaveBeenCalled();
  });

  it("still reaches the mark-all branch for a body carrying no id at all", async () => {
    await PATCH(request({ somethingElse: true }), noParams);

    expect(updateMany).toHaveBeenCalledTimes(1);
  });
});
