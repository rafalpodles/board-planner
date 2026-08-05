import { describe, it, expect } from "vitest";
import { categoryDiff } from "./category-diff";

const bug = { _id: "1", name: "bug", color: "#ef4444" };
const doc = { _id: "2", name: "doc", color: "#3b82f6" };

describe("categoryDiff", () => {
  it("finds nothing to do when the draft matches", () => {
    expect(categoryDiff([bug, doc], [bug, doc])).toEqual({
      added: [],
      removed: [],
      changed: [],
    });
  });

  it("reports a category with no id as added", () => {
    const next = [bug, doc, { name: "spike", color: "#22c55e" }];
    const diff = categoryDiff([bug, doc], next);

    expect(diff.added).toEqual([{ name: "spike", color: "#22c55e" }]);
    expect(diff.removed).toEqual([]);
    expect(diff.changed).toEqual([]);
  });

  it("reports a category dropped from the draft as removed", () => {
    const diff = categoryDiff([bug, doc], [bug]);

    expect(diff.removed).toEqual(["doc"]);
    expect(diff.added).toEqual([]);
  });

  // The PATCH takes the original name, so the diff has to carry it rather than the new one
  it("reports a rename against the name the server still knows", () => {
    const diff = categoryDiff([bug, doc], [{ ...bug, name: "defect" }, doc]);

    expect(diff.changed).toEqual([{ name: "bug", newName: "defect", color: "#ef4444" }]);
  });

  it("reports a recolour without a newName", () => {
    const diff = categoryDiff([bug, doc], [{ ...bug, color: "#f97316" }, doc]);

    expect(diff.changed).toEqual([{ name: "bug", color: "#f97316" }]);
  });

  it("reports a rename and recolour together", () => {
    const diff = categoryDiff([bug], [{ ...bug, name: "defect", color: "#f97316" }]);

    expect(diff.changed).toEqual([{ name: "bug", newName: "defect", color: "#f97316" }]);
  });

  it("handles an add, a removal and a rename in one draft", () => {
    const diff = categoryDiff(
      [bug, doc],
      [{ ...bug, name: "defect" }, { name: "spike", color: "#22c55e" }]
    );

    expect(diff.added).toEqual([{ name: "spike", color: "#22c55e" }]);
    expect(diff.removed).toEqual(["doc"]);
    expect(diff.changed).toEqual([{ name: "bug", newName: "defect", color: "#ef4444" }]);
  });
});
