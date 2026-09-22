// @vitest-environment happy-dom
import { describe, it, expect } from "vitest";
import { act, renderHook } from "@testing-library/react";
import type { KeyboardEvent } from "react";
import { useTriggerAutocomplete, type Trigger } from "./use-trigger-autocomplete";

function taskTrigger(): Trigger {
  return {
    name: "task",
    pattern: /BP-(\d*)$/,
    suggest: () => [
      { id: "1", insert: "BP-1", label: "BP-1" },
      { id: "2", insert: "BP-2", label: "BP-2" },
      { id: "3", insert: "BP-3", label: "BP-3" },
    ],
  };
}

function press(key: string): KeyboardEvent<HTMLTextAreaElement> {
  return { key, preventDefault: () => {} } as KeyboardEvent<HTMLTextAreaElement>;
}

async function openedList() {
  const textarea = { current: null };
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
});
