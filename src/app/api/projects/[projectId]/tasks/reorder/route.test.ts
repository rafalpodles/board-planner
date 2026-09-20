import { describe, it, expect, vi, beforeEach } from "vitest";

const getAuthUser = vi.fn();
const check = vi.fn();
const taskFind = vi.fn();
const taskBulkWrite = vi.fn();

vi.mock("@/lib/db", () => ({ connectDB: vi.fn() }));
vi.mock("@/lib/auth", () => ({ getAuthUser, RateLimitError: class extends Error {} }));
vi.mock("@/lib/grants", () => ({ check }));
vi.mock("@/models/task", () => ({ Task: { find: taskFind, bulkWrite: taskBulkWrite } }));

const { PUT } = await import("./route");

const PROJECT_ID = "507f1f77bcf86cd799439011";
const id = (n: number) => `507f1f77bcf86cd7994390${String(20 + n).padStart(2, "0")}`;

function put(body: unknown) {
  return PUT(
    new Request(`http://localhost/api/projects/${PROJECT_ID}/tasks/reorder`, {
      method: "PUT",
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ projectId: PROJECT_ID }) }
  );
}

interface Row {
  _id: string;
  order: number;
  createdAt: Date;
  taskNumber: number;
}

/**
 * The board as stored. `order` is what the rows already hold, which is the thing a reorder is
 * diffed against — the route writes only the rows whose position actually moves.
 */
function board(rows: Array<Partial<Row> & { _id: string }>) {
  const stored: Row[] = rows.map((r, i) => ({
    order: i,
    createdAt: new Date(2026, 0, 1 + i),
    taskNumber: i + 1,
    ...r,
  }));
  taskFind.mockReturnValue({ select: () => ({ lean: async () => stored }) });
  return stored;
}

/** `id:order` for every row the bulkWrite would touch, in the order it would touch them. */
const writes = () =>
  (taskBulkWrite.mock.calls[0]?.[0] ?? []).map(
    (w: { updateOne: { filter: { _id: string }; update: { $set: { order: number } } } }) =>
      `${w.updateOne.filter._id}:${w.updateOne.update.$set.order}`
  );

beforeEach(() => {
  vi.clearAllMocks();
  getAuthUser.mockResolvedValue({ _id: "u1", role: "member" });
  check.mockResolvedValue(true);
  taskBulkWrite.mockResolvedValue({});
  board([{ _id: id(1) }, { _id: id(2) }, { _id: id(3) }]);
});

describe("PUT /api/projects/:projectId/tasks/reorder", () => {
  it("renumbers the rows whose position moved", async () => {
    const res = await put({ order: [id(3), id(1), id(2)] });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ updated: 3 });
    expect(writes()).toEqual([`${id(3)}:0`, `${id(1)}:1`, `${id(2)}:2`]);
  });

  // The whole point of the diff: a drag that puts everything back where it was should not
  // rewrite the board, and a list already numbered 0,1,2 is the common case on a second drag.
  it("writes nothing when the sequence is already stored", async () => {
    const res = await put({ order: [id(1), id(2), id(3)] });

    expect(await res.json()).toEqual({ updated: 0 });
    expect(taskBulkWrite).not.toHaveBeenCalled();
  });

  // A reorder touches many rows at once. Letting the schema stamp updatedAt would move the
  // whole board to "just now" on every drag, and the board sorts and reports on that field.
  it("suppresses the timestamp bump", async () => {
    await put({ order: [id(3), id(1), id(2)] });

    expect(taskBulkWrite).toHaveBeenCalledWith(expect.anything(), { timestamps: false });
  });

  /**
   * The client only ever sends the rows it can see, so a filter or a sprint scope makes the
   * received sequence a subset. It is placed into the slots those tasks already occupied among
   * all of them — a hidden row must keep its place, not be shuffled by a list that never saw it.
   */
  it("places a filtered subset into the slots it already occupied", async () => {
    board([{ _id: id(1) }, { _id: id(2) }, { _id: id(3) }, { _id: id(4) }]);

    const res = await put({ order: [id(4), id(2)] });

    expect(res.status).toBe(200);
    // Slots 1 and 3 are the ones the subset held; id(1) and id(3) never move.
    expect(writes()).toEqual([`${id(4)}:1`, `${id(2)}:3`]);
  });

  /**
   * Ties at the schema default are the bug this route was written to clear: tasks created by a
   * writer that never set `order` all sit at 0, and a drag among them looked like it did nothing.
   * Renumbering the whole project is what separates them — so after a reorder of a board that
   * was entirely tied, the three rows hold three distinct positions.
   */
  it("clears a board tied at the schema default", async () => {
    board([
      { _id: id(1), order: 0, createdAt: new Date(2026, 0, 1), taskNumber: 1 },
      { _id: id(2), order: 0, createdAt: new Date(2026, 0, 2), taskNumber: 2 },
      { _id: id(3), order: 0, createdAt: new Date(2026, 0, 3), taskNumber: 3 },
    ]);

    const res = await put({ order: [id(3), id(1), id(2)] });

    expect(res.status).toBe(200);
    // id(3) is the newest, so the tie already put it first and it alone keeps its stored 0.
    expect(writes()).toEqual([`${id(1)}:1`, `${id(2)}:2`]);
    const settled = [0, ...writes().map((w: string) => Number(w.split(":")[1]))];
    expect(new Set(settled).size).toBe(3);
  });

  describe("what it refuses", () => {
    it("401s with no credential", async () => {
      getAuthUser.mockResolvedValue(null);

      expect((await put({ order: [id(1)] })).status).toBe(401);
      expect(taskBulkWrite).not.toHaveBeenCalled();
    });

    it("403s for somebody with no access to the project", async () => {
      check.mockResolvedValue(false);

      expect((await put({ order: [id(1)] })).status).toBe(403);
      expect(taskFind).not.toHaveBeenCalled();
    });

    it("refuses an order that is not an array of strings", async () => {
      expect((await put({ order: [id(1), 7] })).status).toBe(400);
      expect((await put({ order: "everything" })).status).toBe(400);
      expect((await put({})).status).toBe(400);
      expect(taskBulkWrite).not.toHaveBeenCalled();
    });

    it("refuses more than a thousand ids", async () => {
      const res = await put({ order: Array.from({ length: 1001 }, (_, i) => id(i)) });

      expect(res.status).toBe(400);
      expect(taskFind).not.toHaveBeenCalled();
    });

    // Before Mongoose sees it: a malformed id casts to a CastError there, which is a 500.
    it("refuses a malformed id without reading the board", async () => {
      const res = await put({ order: [id(1), "not-an-id"] });

      expect(res.status).toBe(400);
      expect(taskFind).not.toHaveBeenCalled();
    });

    // The message, not only the status: the unknown-ids check further down refuses this request
    // too, so a test reading the 400 alone would stay green with the duplicate guard deleted.
    it("refuses duplicates, which would give one task two positions", async () => {
      const res = await put({ order: [id(1), id(2), id(1)] });

      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "order contains duplicate ids" });
      expect(taskBulkWrite).not.toHaveBeenCalled();
    });
  });

  /**
   * The read and the write are two round trips with no transaction between them, so the board can
   * move underneath a reorder. Two things hold it together, and both are asserted here.
   */
  describe("when the board changes underneath the request", () => {
    // The known-set is built from this project's tasks only. Without it, an id from another board
    // would be placed — and the update filter below would then match nothing, so the caller would
    // be told a position was written that was not.
    it("refuses an id that is not this project's, even though it is a real task", async () => {
      board([{ _id: id(1) }, { _id: id(2) }]);

      const res = await put({ order: [id(1), id(2), id(9)] });

      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "order contains unknown task ids" });
      expect(taskBulkWrite).not.toHaveBeenCalled();
    });

    // A task moved to another project between the read and the write must not be renumbered
    // there. The project is in every update filter, so that write simply matches nothing.
    it("scopes every write to the project, not to the id alone", async () => {
      await put({ order: [id(3), id(1), id(2)] });

      const filters = taskBulkWrite.mock.calls[0][0].map(
        (w: { updateOne: { filter: unknown } }) => w.updateOne.filter
      );
      expect(filters).toEqual([
        { _id: id(3), project: PROJECT_ID },
        { _id: id(1), project: PROJECT_ID },
        { _id: id(2), project: PROJECT_ID },
      ]);
    });

    // A task created after the read is absent from the sequence and from the board the route
    // computed, so it keeps its own stored order and the reorder does not touch it.
    it("leaves a row the read never saw alone", async () => {
      await put({ order: [id(2), id(1)] });

      expect(writes().join(" ")).not.toContain(id(3));
    });
  });
});
