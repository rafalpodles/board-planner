import { describe, it, expect } from "vitest";
import { activityLines, commentLines } from "./history";

describe("commentLines", () => {
  it("gives each comment the id it is addressed by, who wrote it and when, and the reactions as counts", () => {
    expect(
      commentLines([
        {
          _id: "c1",
          author: { username: "rafal" },
          body: "Looks right",
          createdAt: "2026-10-05T10:00:00.000Z",
          reactions: [{ emoji: "👍" }, { emoji: "👍" }, { emoji: "🎉" }],
        },
      ])
    ).toEqual([
      {
        id: "c1",
        author: "rafal",
        body: "Looks right",
        createdAt: "2026-10-05T10:00:00.000Z",
        reactions: [
          { emoji: "👍", count: 2 },
          { emoji: "🎉", count: 1 },
        ],
      },
    ]);
  });

  it("has no author to name for a comment whose author is gone", () => {
    expect(commentLines([{ _id: "c1", author: null, body: "b" }])[0]).toMatchObject({ author: null, createdAt: null });
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

  it("clips a long value of an ordinary field", () => {
    const [long] = activityLines([{ action: "updated", field: "title", oldValue: "x".repeat(5_000), newValue: "y".repeat(5_000) }], 10);

    expect(long.from).toBe(`${"x".repeat(300)}…`);
    expect(long.to).toBe(`${"y".repeat(300)}…`);
  });

  // The route blanks a description's new text and keeps the old, and says only whether it was cleared; the
  // task page reads that as added, edited or removed, and so must this — "to" empty reads as "cleared"
  it("says a description was added, edited or removed, as the task page does, and never hands its text back", () => {
    const [added, edited, removed] = activityLines(
      [
        { action: "updated", field: "description", oldValue: "", newValue: "", cleared: false },
        { action: "updated", field: "description", oldValue: "the old text", newValue: "", cleared: false },
        { action: "updated", field: "description", oldValue: "the old text", newValue: "", cleared: true },
      ],
      10
    );

    expect([added.to, edited.to, removed.to]).toEqual(["(added)", "(edited)", "(removed)"]);
    expect([added.from, edited.from, removed.from]).toEqual(["", "", ""]);
  });

  it("treats a project field that happens to be called description as the ordinary field it is", () => {
    const [row] = activityLines([{ action: "updated", field: "description", customField: true, oldValue: "a", newValue: "b" }], 10);

    expect(row).toMatchObject({ from: "a", to: "b" });
  });
});
