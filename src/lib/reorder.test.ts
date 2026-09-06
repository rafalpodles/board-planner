import { describe, it, expect } from "vitest";
import { manualOrder, moveItem, placeInto, reorderedIds } from "./reorder";

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

describe("manualOrder", () => {
  const row = (id: string, order: number, createdAt = 0, taskNumber = 1) =>
    ({ id, order, createdAt, taskNumber });

  it("sorts by order, then newest first, then task number", () => {
    expect(manualOrder([row("a", 2), row("b", 1)])).toEqual(["b", "a"]);
    expect(manualOrder([row("a", 0, 100), row("b", 0, 200)])).toEqual(["b", "a"]);
    expect(manualOrder([row("a", 0, 0, 2), row("b", 0, 0, 1)])).toEqual(["b", "a"]);
  });
});

describe("placeInto", () => {
  const all = ["a", "b", "c", "d", "e"];

  it("permutes the moved ids within the slots they already held", () => {
    expect(placeInto(all, ["e", "c", "a"])).toEqual(["e", "b", "c", "d", "a"]);
  });

  it("leaves a full list exactly as given", () => {
    expect(placeInto(all, ["e", "d", "c", "b", "a"])).toEqual(["e", "d", "c", "b", "a"]);
  });

  it("refuses a set that is not a subset of the whole", () => {
    expect(placeInto(all, ["a", "zz"])).toEqual(all);
  });
});
