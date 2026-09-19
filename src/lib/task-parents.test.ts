import { describe, it, expect, vi, beforeEach } from "vitest";

const { find } = vi.hoisted(() => ({ find: vi.fn() }));
vi.mock("@/models/task", () => ({ Task: { find } }));

const { parentsOf } = await import("./task-parents");

/** What `Task.find(...).lean()` hands back. */
function found(docs: unknown[]) {
  find.mockReturnValue({ lean: async () => docs });
}

const EPIC = {
  _id: "epic",
  taskNumber: 644,
  title: "Epic: Phase 1",
  status: "todo",
  relations: [
    { task: "child-a", type: "parent_of" },
    { task: "child-b", type: "parent_of" },
  ],
};

beforeEach(() => {
  find.mockReset();
});

/**
 * The link is stored on the parent, so this reads the far end. Every case here is one where the
 * parent document matched the query but the *entry* inside it did not: `$elemMatch` selects a
 * document, and a parent carries one relation per child plus whatever else it relates to.
 */
describe("parentsOf", () => {
  it("maps each child to the parent that names it", async () => {
    found([EPIC]);

    const parents = await parentsOf("p1", ["child-a", "child-b"]);

    expect(parents.get("child-a")).toEqual({
      _id: "epic",
      taskNumber: 644,
      title: "Epic: Phase 1",
      status: "todo",
    });
    expect(parents.get("child-b")?.taskNumber).toBe(644);
  });

  it("ignores a sibling of the asked-for children carried by the same parent", async () => {
    found([EPIC]);

    const parents = await parentsOf("p1", ["child-a"]);

    expect([...parents.keys()]).toEqual(["child-a"]);
  });

  it("ignores the parent's other relation kinds to the same task", async () => {
    found([
      {
        ...EPIC,
        relations: [
          { task: "child-a", type: "relates" },
          { task: "child-a", type: "parent_of" },
          { task: "child-c", type: "duplicates" },
        ],
      },
    ]);

    const parents = await parentsOf("p1", ["child-a", "child-c"]);

    expect(parents.get("child-a")?.taskNumber).toBe(644);
    expect(parents.has("child-c")).toBe(false);
  });

  it("scopes the query to the project as well as to the ids", async () => {
    found([]);

    await parentsOf("p1", ["child-a"]);

    expect(find).toHaveBeenCalledWith(
      {
        project: "p1",
        relations: { $elemMatch: { task: { $in: ["child-a"] }, type: "parent_of" } },
      },
      "taskNumber title status relations"
    );
  });

  it("asks the database nothing for an empty board", async () => {
    const parents = await parentsOf("p1", []);

    expect(parents.size).toBe(0);
    expect(find).not.toHaveBeenCalled();
  });

  it("survives a parent whose relations array is absent", async () => {
    found([{ _id: "epic", taskNumber: 1, title: "x", status: "todo" }]);

    await expect(parentsOf("p1", ["child-a"])).resolves.toEqual(new Map());
  });
});
