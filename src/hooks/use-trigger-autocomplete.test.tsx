// @vitest-environment happy-dom
import { describe, it, expect } from "vitest";
import { act, renderHook } from "@testing-library/react";
import type { KeyboardEvent } from "react";
import { useTriggerAutocomplete, type Trigger } from "./use-trigger-autocomplete";

function taskTrigger(ids = ["1", "2", "3"]): Trigger {
  return {
    name: "task",
    pattern: /BP-(\d*)$/,
    suggest: () => ids.map((id) => ({ id, insert: `BP-${id}`, label: `BP-${id}` })),
  };
}

function press(key: string): KeyboardEvent<HTMLTextAreaElement> {
  return { key, preventDefault: () => {} } as KeyboardEvent<HTMLTextAreaElement>;
}

async function openedList() {
  const textarea = { current: document.createElement("textarea") };
  const hook = renderHook(({ triggers }) => useTriggerAutocomplete(triggers, textarea, () => {}), {
    initialProps: { triggers: [taskTrigger()] },
  });
  await act(async () => hook.result.current.detect("see BP-", 7));
  return hook;
}

describe("the selection in an open suggestion list", () => {
  it("moves with the arrow keys", async () => {
    const { result } = await openedList();

    act(() => result.current.onKeyDown(press("ArrowDown")));

    expect(result.current.index).toBe(1);
  });

  // Triggers change identity whenever the data behind them lands or refreshes; the list is
  // re-offered then, and used to jump back to the first entry under a person's arrow keys
  it("survives the triggers being rebuilt while the list is open", async () => {
    const { result, rerender } = await openedList();
    act(() => result.current.onKeyDown(press("ArrowDown")));

    await act(async () => rerender({ triggers: [taskTrigger()] }));

    expect(result.current.items).toHaveLength(3);
    expect(result.current.index).toBe(1);
  });

  it("still starts at the top when the text changes", async () => {
    const { result } = await openedList();
    act(() => result.current.onKeyDown(press("ArrowDown")));

    await act(async () => result.current.detect("see BP-1", 8));

    expect(result.current.index).toBe(0);
  });

  it("stays on the same task when the rebuilt list puts it elsewhere", async () => {
    const { result, rerender } = await openedList();
    act(() => result.current.onKeyDown(press("ArrowDown")));

    await act(async () => rerender({ triggers: [taskTrigger(["4", "1", "2", "3"])] }));

    expect(result.current.items[result.current.index].id).toBe("2");
  });

  it("goes back to the top when the selected task is gone from the rebuilt list", async () => {
    const { result, rerender } = await openedList();
    act(() => result.current.onKeyDown(press("ArrowDown")));
    act(() => result.current.onKeyDown(press("ArrowDown")));

    await act(async () => rerender({ triggers: [taskTrigger(["1", "2"])] }));

    expect(result.current.index).toBe(0);
  });
});

describe("a list somebody is done with", () => {
  it("stays shut after Escape when the triggers are rebuilt", async () => {
    const { result, rerender } = await openedList();
    act(() => result.current.onKeyDown(press("Escape")));

    await act(async () => rerender({ triggers: [taskTrigger()] }));

    expect(result.current.items).toHaveLength(0);
    expect(result.current.trigger).toBeNull();
  });

  it("stays shut after a pick when the triggers are rebuilt", async () => {
    const { result, rerender } = await openedList();
    act(() => result.current.onKeyDown(press("Enter")));

    await act(async () => rerender({ triggers: [taskTrigger()] }));

    expect(result.current.items).toHaveLength(0);
  });

  // The reason the rebuilt triggers are asked again at all: a key typed before its data arrived
  it("is still offered once its data arrives, when nothing matched before", async () => {
    const textarea = { current: document.createElement("textarea") };
    const { result, rerender } = renderHook(
      ({ triggers }) => useTriggerAutocomplete(triggers, textarea, () => {}),
      { initialProps: { triggers: [] as Trigger[] } }
    );
    await act(async () => result.current.detect("see BP-", 7));

    await act(async () => rerender({ triggers: [taskTrigger()] }));

    expect(result.current.items).toHaveLength(3);
  });
});
