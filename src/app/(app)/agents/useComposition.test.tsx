// @vitest-environment happy-dom
import { describe, it, expect } from "vitest";
import { useLayoutEffect } from "react";
import { act, renderHook } from "@testing-library/react";
import { sameComposition, useComposition } from "./useComposition";
import type { AgentComposition } from "@/types";

const empty: AgentComposition = { analysis: [], implementation: [], verification: [], delivery: [] };

describe("sameComposition", () => {
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

describe("useComposition", () => {
  const stored: AgentComposition = { ...empty, implementation: [{ key: "implement" }] };

  it("never commits an empty editor over an agent that arrived after the first render", () => {
    const commits: AgentComposition[] = [];
    const { rerender } = renderHook(
      ({ source }: { source?: AgentComposition }) => {
        const c = useComposition(source, () => undefined);
        useLayoutEffect(() => {
          commits.push(c.composition);
        });
        return c;
      },
      { initialProps: {} }
    );

    rerender({ source: stored });

    expect(commits.at(-1)).toEqual(stored);
    expect(commits.slice(1).every((c) => sameComposition(c, stored))).toBe(true);
  });

  const theirs: AgentComposition = { ...empty, verification: [{ key: "review" }] };
  const hook = () =>
    renderHook(({ source }: { source?: AgentComposition }) => useComposition(source, () => undefined), {
      initialProps: { source: stored },
    });

  it("takes a newer agent when nothing was changed here", () => {
    const { result, rerender } = hook();

    rerender({ source: theirs });

    expect(sameComposition(result.current.composition, theirs)).toBe(true);
  });

  it("keeps what was changed here when a newer agent arrives", () => {
    const { result, rerender } = hook();
    act(() => result.current.addTo("delivery", "push"));

    rerender({ source: theirs });

    expect(result.current.composition.delivery).toEqual([{ key: "push" }]);
  });

  it("is not reset by the read that follows its own save", () => {
    const { result, rerender } = hook();
    act(() => result.current.addTo("delivery", "push"));
    const saved = structuredClone(result.current.composition);

    rerender({ source: saved });
    rerender({ source: structuredClone(saved) });

    expect(result.current.composition.delivery).toEqual([{ key: "push" }]);
  });

  it("reads an agent stored before entries existed as the same composition", () => {
    const legacy = { ...empty, implementation: ["implement"] } as unknown as AgentComposition;
    expect(sameComposition(stored, legacy)).toBe(true);
  });
});
