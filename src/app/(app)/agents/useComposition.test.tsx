// @vitest-environment happy-dom
import { describe, it, expect } from "vitest";
import { useLayoutEffect } from "react";
import { act, renderHook } from "@testing-library/react";
import { sameComposition, useComposition } from "./useComposition";
import type { AgentComposition } from "@/types";
import type { DragEndEvent } from "@dnd-kit/core";

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

describe("where a dropped block goes in a bucket that holds some", () => {
  const delivery: AgentComposition = {
    ...empty,
    implementation: [{ key: "implement" }],
    delivery: [{ key: "push" }, { key: "pull-request" }],
  };

  function drop(
    activeId: (uids: Record<string, string>) => string,
    overKey: string,
    after: boolean
  ) {
    const { result } = renderHook(() => useComposition(delivery, () => undefined));
    const uids = Object.fromEntries(
      Object.values(result.current.entries).flat().map((e) => [e.key, e.uid])
    );
    const over = uids[overKey];
    act(() =>
      result.current.onDragEnd({
        active: { id: activeId(uids) },
        over: { id: over },
        collisions: [{ id: over, data: { after } }],
      } as unknown as DragEndEvent)
    );
    return result.current.composition;
  }

  it("puts a palette block after the card when the pointer was below its middle", () => {
    expect(drop(() => "new:merge", "push", true).delivery.map((e) => e.key)).toEqual([
      "push",
      "merge",
      "pull-request",
    ]);
  });

  it("puts it before the card when the pointer was above its middle", () => {
    expect(drop(() => "new:merge", "pull-request", false).delivery.map((e) => e.key)).toEqual([
      "push",
      "merge",
      "pull-request",
    ]);
  });

  it("does the same for a card coming from another bucket", () => {
    const moved = drop((uids) => uids.implement, "push", true);
    expect(moved.delivery.map((e) => e.key)).toEqual(["push", "implement", "pull-request"]);
    expect(moved.implementation).toEqual([]);
  });

  // Within its own bucket arrayMove already lands a card where the preview showed it
  it("leaves a move inside one bucket to the sortable order", () => {
    expect(drop((uids) => uids["pull-request"], "push", true).delivery.map((e) => e.key)).toEqual([
      "pull-request",
      "push",
    ]);
  });
});
