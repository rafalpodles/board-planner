import { describe, it, expect } from "vitest";
import { activityLines, commentLines } from "./history";

describe("commentLines", () => {
  it("gives each comment the id it is addressed by, who wrote it and when, and the reactions as counts", () => {
    expect(
      commentLines([
        {
          _id: "c1",
          author: { username: "rafal", ...{ fullName: "Rafal", _id: "u1" } },
          body: "Looks right",
          createdAt: "2026-10-05T10:00:00.000Z",
          updatedAt: "2026-10-05T10:00:00.000Z",
          reactions: [{ emoji: "👍" }, { emoji: "👍" }, { emoji: "🎉" }],
        },
      ])
    ).toEqual([
      {
        id: "c1",
        author: "rafal",
        body: "Looks right",
        createdAt: "2026-10-05T10:00:00.000Z",
        edited: false,
        reactions: [
          { emoji: "👍", count: 2 },
          { emoji: "🎉", count: 1 },
        ],
      },
    ]);
  });

  it("says a comment was edited when it changed after it was written", () => {
    const [line] = commentLines([
      { _id: "c1", author: { username: "a" }, body: "b", createdAt: "2026-10-05T10:00:00.000Z", updatedAt: "2026-10-05T11:00:00.000Z" },
    ]);

    expect(line.edited).toBe(true);
  });

  it("has no author to name for a comment whose author is gone", () => {
    expect(commentLines([{ _id: "c1", author: null, body: "b" }])[0]).toMatchObject({ author: null, createdAt: null, edited: false });
  });
});

describe("activityLines", () => {
  const rows = [
    { user: { username: "rafal" }, action: "updated", field: "title", oldValue: "Old", newValue: "New", createdAt: "2026-10-05T12:00:00.000Z" },
    { user: null, action: "status_changed", field: "status", oldValue: "todo", newValue: "done", createdAt: "2026-10-05T11:00:00.000Z" },
    { user: { username: "rafal" }, action: "created", createdAt: "2026-10-05T10:00:00.000Z" },
  ];

  it("says when, by whom, what changed and from what to what, keeping the order it was given", () => {
    expect(activityLines(rows, 30)).toEqual([
      { at: "2026-10-05T12:00:00.000Z", by: "rafal", action: "updated", field: "title", from: "Old", to: "New" },
      { at: "2026-10-05T11:00:00.000Z", by: null, action: "status_changed", field: "status", from: "todo", to: "done" },
      { at: "2026-10-05T10:00:00.000Z", by: "rafal", action: "created", field: null, from: "", to: "" },
    ]);
  });

  it("returns only as many as asked for", () => {
    expect(activityLines(rows, 2)).toHaveLength(2);
  });

  it("clips a long value instead of handing a whole description back, and says a cleared one is cleared", () => {
    const [long, cleared] = activityLines(
      [
        { action: "updated", field: "description", oldValue: "x".repeat(5_000), newValue: "y".repeat(5_000) },
        { action: "updated", field: "description", oldValue: "was", newValue: "", cleared: true },
      ],
      10
    );

    expect(long.from).toBe(`${"x".repeat(300)}…`);
    expect(long.to).toBe(`${"y".repeat(300)}…`);
    expect(cleared.to).toBe("(cleared)");
  });
});
