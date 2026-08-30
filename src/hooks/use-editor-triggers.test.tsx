// @vitest-environment happy-dom
import { describe, it, expect, vi } from "vitest";
import { renderHook } from "@testing-library/react";

vi.mock("@/hooks/use-api", () => ({
  // Never settles, so the hook's fetch cannot land a state update outside act()
  useApi: () => ({ get: vi.fn(() => new Promise(() => {})) }),
}));

const { useEditorTriggers } = await import("./use-editor-triggers");

function taskTrigger(projectKey: string) {
  const { result } = renderHook(() => useEditorTriggers("p1", projectKey));
  return result.current.find((t) => t.name === "task")!;
}

/**
 * BP-329. The key is interpolated into a RegExp. BP-401 constrained what a key may be at every
 * route that writes one, but checked only values that change and migrated nothing — so a key stored
 * before it is still there, and unescaped one that does not compile threw inside a useMemo, taking
 * down the editor for everyone who opened a task on that board.
 */
describe("the task trigger built from a project key", () => {
  // The control: the ordinary case has to keep working, or the escaping below proves nothing
  it("still matches the key it was built from", () => {
    const trigger = taskTrigger("BP");

    expect("see BP-32".match(trigger.pattern)?.[1]).toBe("32");
    expect(trigger.pattern.test("see XX-32")).toBe(false);
  });

  it("does not blow up on a key made of regex punctuation", () => {
    expect(() => taskTrigger("C(")).not.toThrow();
  });

  // Escaped, not stripped: the key is still what the trigger matches
  it("matches a punctuation key as text", () => {
    const trigger = taskTrigger("C(");

    expect("see C(-7".match(trigger.pattern)?.[1]).toBe("7");
    expect(trigger.pattern.test("see C-7")).toBe(false);
  });

  // `A.C` unescaped matches `ABC`, which is a different board's key
  it("does not let a dot in a key match some other board's", () => {
    const trigger = taskTrigger("A.C");

    expect(trigger.pattern.test("see ABC-7")).toBe(false);
    expect("see A.C-7".match(trigger.pattern)?.[1]).toBe("7");
  });
});
