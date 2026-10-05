import { describe, it, expect } from "vitest";
import { findItem, shownCriteria, type Criterion } from "./checklist-edit";

const HELD: Criterion[] = [
  { _id: "507f1f77bcf86cd799439011", text: "the card is on the board", done: true },
  { _id: "507f1f77bcf86cd799439012", text: "with its checklist", done: false },
  { _id: "507f1f77bcf86cd799439013", text: "and it is documented", done: true },
];

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

describe("shownCriteria", () => {
  it("answers with id, text and done, and nothing else", () => {
    expect(shownCriteria([{ _id: "a".repeat(24), text: "t", done: true, ...{ extra: 1 } } as Criterion])).toEqual([
      { id: "a".repeat(24), text: "t", done: true },
    ]);
  });
});
