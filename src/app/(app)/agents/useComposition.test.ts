import { describe, it, expect } from "vitest";
import { sameComposition } from "./useComposition";
import type { AgentComposition } from "@/types";

const empty: AgentComposition = { analysis: [], implementation: [], verification: [], delivery: [] };

describe("sameComposition", () => {
  // The editor's "Unsaved changes" and its leave prompt both rest on this. A false difference on an
  // untouched agent would nag everybody who merely opened one.
  it("finds no difference in an agent nobody has touched", () => {
    const stored: AgentComposition = {
      ...empty,
      implementation: [{ key: "implement", params: { model: "sonnet" } }],
    };
    expect(sameComposition(structuredClone(stored), stored)).toBe(true);
  });

  it("sees a block placed in a phase", () => {
    expect(sameComposition({ ...empty, implementation: [{ key: "implement" }] }, empty)).toBe(false);
  });

  it("sees a block moved to another phase", () => {
    const before = { ...empty, analysis: [{ key: "review" }] };
    const after = { ...empty, verification: [{ key: "review" }] };
    expect(sameComposition(after, before)).toBe(false);
  });

  it("sees a changed parameter", () => {
    const before = { ...empty, verification: [{ key: "diff-size", params: { maxLines: "400" } }] };
    const after = { ...empty, verification: [{ key: "diff-size", params: { maxLines: "800" } }] };
    expect(sameComposition(after, before)).toBe(false);
  });

  it("treats an agent that has not loaded yet as empty rather than crashing", () => {
    expect(sameComposition(empty, undefined)).toBe(true);
  });
});
