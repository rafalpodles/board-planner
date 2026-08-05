// @vitest-environment happy-dom
import { describe, it, expect } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useDraft } from "./use-draft";

interface Row {
  _id?: string;
  name: string;
}

describe("useDraft baseline", () => {
  /**
   * The reason this exists: settings lists reconcile on save by diffing the draft
   * against a baseline. They used to diff against the live `project`, which any other
   * group's save replaces — so a row that arrived underneath looked like one the user
   * had deleted, and the save issued a DELETE for it.
   */
  it("exposes the values the draft started from", () => {
    const rows: Row[] = [{ _id: "1", name: "A" }];
    const { result } = renderHook(() => useDraft({ rows }));

    expect(result.current.baseline.rows).toEqual(rows);
  });

  it("holds the baseline still while the draft is edited", () => {
    const { result } = renderHook(() =>
      useDraft<{ rows: Row[] }>({ rows: [{ _id: "1", name: "A" }] })
    );

    act(() => result.current.set("rows", [{ _id: "1", name: "renamed" }]));

    expect(result.current.value.rows).toEqual([{ _id: "1", name: "renamed" }]);
    expect(result.current.baseline.rows).toEqual([{ _id: "1", name: "A" }]);
  });

  it("moves the baseline to whatever the server returned on commit", () => {
    const { result } = renderHook(() =>
      useDraft<{ rows: Row[] }>({ rows: [{ _id: "1", name: "A" }] })
    );

    act(() => result.current.commit({ rows: [{ _id: "1", name: "A" }, { _id: "2", name: "B" }] }));

    expect(result.current.baseline.rows).toHaveLength(2);
    expect(result.current.count).toBe(0);
  });

  // A save that fails part-way must adopt what landed without throwing away the edits
  // that did not: commit() moves both sides, which reverted the user's work
  it("moves the baseline on rebase and leaves the draft alone", () => {
    const { result } = renderHook(() =>
      useDraft<{ rows: Row[] }>({ rows: [{ _id: "1", name: "A" }] })
    );

    act(() => result.current.set("rows", [{ _id: "1", name: "A" }, { name: "new" }]));
    act(() => result.current.rebase({ rows: [{ _id: "1", name: "A" }, { _id: "2", name: "landed" }] }));

    expect(result.current.baseline.rows).toHaveLength(2);
    expect(result.current.value.rows).toEqual([{ _id: "1", name: "A" }, { name: "new" }]);
    expect(result.current.count).toBe(1);
  });

  it("returns the draft to the baseline on discard", () => {
    const { result } = renderHook(() =>
      useDraft<{ rows: Row[] }>({ rows: [{ _id: "1", name: "A" }] })
    );

    act(() => result.current.set("rows", []));
    expect(result.current.count).toBe(1);

    act(() => result.current.discard());

    expect(result.current.value.rows).toEqual([{ _id: "1", name: "A" }]);
    expect(result.current.count).toBe(0);
  });
});
