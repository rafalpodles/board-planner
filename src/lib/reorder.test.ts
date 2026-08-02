import { describe, it, expect } from "vitest";
import { moveItem } from "./reorder";

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
