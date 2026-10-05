import { describe, it, expect } from "vitest";
import { addItem, findItem, mergeCriteria, removeItem, setItem, shownCriteria, type Criterion } from "./checklist-edit";

const HELD: Criterion[] = [
  { _id: "507f1f77bcf86cd799439011", text: "the card is on the board", done: true },
  { _id: "507f1f77bcf86cd799439012", text: "with its checklist", done: false },
  { _id: "507f1f77bcf86cd799439013", text: "and it is documented", done: true },
];

describe("mergeCriteria", () => {
  it("keeps the id and the done state of a line whose text is unchanged, even when the line is plain", () => {
    const merged = mergeCriteria("the card is on the board\nwith its checklist\nand it is documented", HELD);

    expect(merged).toEqual([
      { _id: "507f1f77bcf86cd799439011", text: "the card is on the board", done: true },
      { _id: "507f1f77bcf86cd799439012", text: "with its checklist", done: false },
      { _id: "507f1f77bcf86cd799439013", text: "and it is documented", done: true },
    ]);
  });

  it("lets a line that states its own box decide done, either way", () => {
    const merged = mergeCriteria("- [ ] the card is on the board\n- [x] with its checklist", HELD);

    expect(merged).toEqual([
      { _id: "507f1f77bcf86cd799439011", text: "the card is on the board", done: false },
      { _id: "507f1f77bcf86cd799439012", text: "with its checklist", done: true },
    ]);
  });

  it("gives a new line no id and an unchecked box, and an edited line the same", () => {
    const merged = mergeCriteria("- [x] the card is on the board\n- a brand new line\n- [ ] with its checklist, reworded", HELD);

    expect(merged).toEqual([
      { _id: "507f1f77bcf86cd799439011", text: "the card is on the board", done: true },
      { text: "a brand new line", done: false },
      { text: "with its checklist, reworded", done: false },
    ]);
  });

  it("matches a repeated line to a stored one once each, in order", () => {
    const twins: Criterion[] = [
      { _id: "507f1f77bcf86cd799439021", text: "same", done: true },
      { _id: "507f1f77bcf86cd799439022", text: "same", done: false },
    ];

    expect(mergeCriteria("same\nsame\nsame", twins)).toEqual([
      { _id: "507f1f77bcf86cd799439021", text: "same", done: true },
      { _id: "507f1f77bcf86cd799439022", text: "same", done: false },
      { text: "same", done: false },
    ]);
  });

  it("drops the criteria the list no longer names, and an empty list clears the checklist", () => {
    expect(mergeCriteria("with its checklist", HELD)).toHaveLength(1);
    expect(mergeCriteria("", HELD)).toEqual([]);
    expect(mergeCriteria("\n  \n", HELD)).toEqual([]);
  });

  it("starts from nothing on a task with no checklist", () => {
    expect(mergeCriteria("- [x] first\n- second", [])).toEqual([
      { text: "first", done: true },
      { text: "second", done: false },
    ]);
  });
});

describe("findItem", () => {
  it("finds a criterion by id, in either case, or by its exact text in any case", () => {
    expect(findItem(HELD, "507f1f77bcf86cd799439012")).toBe(1);
    expect(findItem(HELD, "507F1F77BCF86CD799439012")).toBe(1);
    expect(findItem(HELD, "AND IT IS DOCUMENTED")).toBe(2);
  });

  it("refuses text two criteria share, with their ids", () => {
    const twins: Criterion[] = [
      { _id: "507f1f77bcf86cd799439021", text: "same" },
      { _id: "507f1f77bcf86cd799439022", text: "Same" },
    ];

    expect(() => findItem(twins, "same")).toThrow(/2 criteria read "same".*507f1f77bcf86cd799439021, 507f1f77bcf86cd799439022/);
  });

  it("names what the task has when nothing matches, and bounds how much it names", () => {
    expect(() => findItem(HELD, "nope")).toThrow(/No criterion "nope".*"the card is on the board", "with its checklist"/);
    expect(() => findItem([], "x")).toThrow(/It has: none/);

    const many = Array.from({ length: 20 }, (_, i) => ({ _id: `507f1f77bcf86cd7994391${String(i).padStart(2, "0")}`, text: `item ${i}` }));
    expect(() => findItem(many, "nope")).toThrow(/and 12 more/);
  });
});

describe("changing one item", () => {
  it("adds to the end without touching the others", () => {
    const next = addItem(HELD, "one more", false);

    expect(next.slice(0, 3)).toEqual(HELD);
    expect(next[3]).toEqual({ text: "one more", done: false });
  });

  it("ticks one, leaving every id and the other states", () => {
    const next = setItem(HELD, "with its checklist", { done: true });

    expect(next.map((i) => [i._id, i.done])).toEqual([
      ["507f1f77bcf86cd799439011", true],
      ["507f1f77bcf86cd799439012", true],
      ["507f1f77bcf86cd799439013", true],
    ]);
  });

  it("rewords one by id and keeps its id and state", () => {
    const next = setItem(HELD, "507f1f77bcf86cd799439013", { text: "and it is documented well" });

    expect(next[2]).toEqual({ _id: "507f1f77bcf86cd799439013", text: "and it is documented well", done: true });
  });

  it("removes one and keeps the rest as they were", () => {
    expect(removeItem(HELD, "with its checklist")).toEqual([HELD[0], HELD[2]]);
  });

  it("does not change the list it was given", () => {
    const before = JSON.stringify(HELD);

    setItem(HELD, "with its checklist", { done: true });
    removeItem(HELD, "with its checklist");
    addItem(HELD, "x", true);

    expect(JSON.stringify(HELD)).toBe(before);
  });
});

describe("shownCriteria", () => {
  it("answers with id, text and done, and nothing else", () => {
    expect(shownCriteria([{ _id: "a".repeat(24), text: "t", done: true, ...{ extra: 1 } } as Criterion])).toEqual([
      { id: "a".repeat(24), text: "t", done: true },
    ]);
  });
});
