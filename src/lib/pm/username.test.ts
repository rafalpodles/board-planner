import { describe, it, expect } from "vitest";
import { PM_USERNAME, withAiMark } from "./username";

// BP-942
describe("withAiMark", () => {
  it("marks the PM's name as an AI's and leaves a person's alone", () => {
    expect(withAiMark("PM Agent", PM_USERNAME)).toBe("PM Agent (AI)");
    expect(withAiMark("Ada Lovelace", "ada")).toBe("Ada Lovelace");
    expect(withAiMark("pm-lead", "pm-lead")).toBe("pm-lead");
    expect(withAiMark("Unknown", undefined)).toBe("Unknown");
  });
});
