import { describe, it, expect } from "vitest";
import { destinationIndex, dropEdge, moveItem, reorderedIds } from "./reorder";

const list = ["a", "b", "c", "d"];

describe("moveItem", () => {
  it("moves an item down", () => {
    expect(moveItem(list, 0, 2)).toEqual(["b", "c", "a", "d"]);
  });

  it("moves an item up", () => {
    expect(moveItem(list, 3, 1)).toEqual(["a", "d", "b", "c"]);
  });

  it("moves to the ends", () => {
    expect(moveItem(list, 0, 3)).toEqual(["b", "c", "d", "a"]);
    expect(moveItem(list, 3, 0)).toEqual(["d", "a", "b", "c"]);
  });

  it("leaves the array alone", () => {
    moveItem(list, 0, 3);
    expect(list).toEqual(["a", "b", "c", "d"]);
  });

  it("returns the same reference when nothing moves", () => {
    expect(moveItem(list, 2, 2)).toBe(list);
  });

  // A drop that lands outside the list must not silently drop an item
  it("ignores out-of-range indices", () => {
    expect(moveItem(list, -1, 2)).toBe(list);
    expect(moveItem(list, 1, 9)).toBe(list);
    expect(moveItem(list, 9, 1)).toBe(list);
  });

  it("keeps every item, whatever the move", () => {
    for (let from = 0; from < list.length; from++) {
      for (let to = 0; to < list.length; to++) {
        expect([...moveItem(list, from, to)].sort()).toEqual([...list].sort());
      }
    }
  });
});

describe("dropEdge", () => {
  const rect = { top: 100, height: 40 };

  it("reads the top half as before and the bottom half as after", () => {
    expect(dropEdge(105, rect)).toBe("before");
    expect(dropEdge(135, rect)).toBe("after");
  });

  it("puts the midpoint in the bottom half", () => {
    expect(dropEdge(120, rect)).toBe("after");
  });
});

describe("destinationIndex", () => {
  // Dragging forwards removes the item first, so the gap shifts back by one
  it("lands the item on the chosen side when dragging forwards", () => {
    const items = ["a", "b", "c", "d"];
    expect(moveItem(items, 0, destinationIndex(0, 2, "before"))).toEqual(["b", "a", "c", "d"]);
    expect(moveItem(items, 0, destinationIndex(0, 2, "after"))).toEqual(["b", "c", "a", "d"]);
  });

  it("lands the item on the chosen side when dragging backwards", () => {
    const items = ["a", "b", "c", "d"];
    expect(moveItem(items, 3, destinationIndex(3, 1, "before"))).toEqual(["a", "d", "b", "c"]);
    expect(moveItem(items, 3, destinationIndex(3, 1, "after"))).toEqual(["a", "b", "d", "c"]);
  });

  it("is a no-op on either side of the dragged item itself", () => {
    expect(destinationIndex(1, 1, "before")).toBe(1);
    expect(destinationIndex(1, 1, "after")).toBe(1);
  });
});

describe("reorderedIds", () => {
  const ids = ["a", "b", "c", "d"];

  it("moves the dragged id onto the target's position", () => {
    expect(reorderedIds(ids, "a", "c")).toEqual(["b", "c", "a", "d"]);
    expect(reorderedIds(ids, "d", "b")).toEqual(["a", "d", "b", "c"]);
  });

  it("reports nothing when the drop changes no order", () => {
    expect(reorderedIds(ids, "b", "b")).toBeNull();
  });

  it("reports nothing for an id that is not in the list", () => {
    expect(reorderedIds(ids, "a", "zz")).toBeNull();
    expect(reorderedIds(ids, "zz", "a")).toBeNull();
  });
});
