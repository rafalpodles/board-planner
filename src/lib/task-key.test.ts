import { describe, it, expect } from "vitest";
import { taskKeyOf } from "./task-key";

/**
 * The missing-project case is the whole reason this exists: `task-service.ts` open-coded both
 * spellings nine times, in three variants that disagreed about it. A key reaches a notification
 * title, a chat message and a GitHub branch match, so the two shapes have to be one decision.
 */
describe("taskKeyOf", () => {
  it("spells a key the way the board does", () => {
    expect(taskKeyOf("BP", 42)).toBe("BP-42");
  });

  it.each([
    ["null", null],
    ["undefined", undefined],
    ["an empty string", ""],
  ])("falls back to the number alone when the project key is %s", (_name, key) => {
    expect(taskKeyOf(key, 42)).toBe("#42");
  });

  // A task deleted with its board, or a payload assembled before the project was read. The number
  // still identifies it in the row it appears in, which is better than "undefined-42".
  it("never writes the absent key into the string", () => {
    expect(taskKeyOf(undefined, 42)).not.toContain("undefined");
    expect(taskKeyOf(null, 42)).not.toContain("null");
  });
});
