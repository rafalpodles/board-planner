// @vitest-environment happy-dom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, act } from "@testing-library/react";
import { TaskCard } from "./TaskCard";
import { ApiTask } from "@/types";

const task = {
  _id: "t1",
  taskNumber: 7,
  title: "A task",
  status: "todo",
  priority: "medium",
  difficulty: "M",
  category: "bug",
  labels: [],
  createdAt: "2026-08-01T00:00:00Z",
  updatedAt: "2026-08-01T00:00:00Z",
} as ApiTask;

function renderCard(over: Partial<React.ComponentProps<typeof TaskCard>> = {}) {
  render(<TaskCard task={task} projectKey="TP" onClick={() => {}} {...over} />);
  return screen.getByRole("link");
}

async function click(el: Element, init: MouseEventInit = {}) {
  const event = new MouseEvent("click", { bubbles: true, cancelable: true, ...init });
  await act(async () => {
    el.dispatchEvent(event);
  });
  return event;
}

async function press(el: Element, key: string, init: KeyboardEventInit = {}) {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init });
  await act(async () => {
    el.dispatchEvent(event);
  });
  return event;
}

async function dragStart(el: Element) {
  const payload = new Map<string, string>();
  const event = new Event("dragstart", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "dataTransfer", {
    value: { setData: (type: string, value: string) => payload.set(type, value), effectAllowed: "" },
  });
  await act(async () => {
    el.dispatchEvent(event);
  });
  return payload;
}

async function mouseDown(el: Element) {
  await act(async () => {
    el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
  });
}

afterEach(cleanup);

describe("TaskCard as a link", () => {
  it("points at the task page so it is tabbable and previewable", () => {
    const card = renderCard();
    expect(card.getAttribute("href")).toBe("/projects/TP/tasks/7");
    expect(card.hasAttribute("tabindex")).toBe(false);
  });

  it("advertises click-to-open and a focus ring", () => {
    const card = renderCard();
    expect(card.className).toContain("cursor-pointer");
    expect(card.className).toContain("focus-visible:ring-2");
    expect(card.className).toContain("focus-visible:ring-primary");
  });

  it("opens the task on a plain click without navigating twice", async () => {
    const onClick = vi.fn();
    const card = renderCard({ onClick });
    const event = await click(card);
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(true);
  });

  it("opens the task on Enter", async () => {
    const onClick = vi.fn();
    const card = renderCard({ onClick });
    const event = await press(card, "Enter");
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(true);
  });

  it("opens the task on Space", async () => {
    const onClick = vi.fn();
    const card = renderCard({ onClick });
    const event = await press(card, " ");
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(true);
  });

  it("keeps Enter away from the board's own list-view handler", async () => {
    const boardHandler = vi.fn();
    document.addEventListener("keydown", boardHandler);
    const card = renderCard();
    await press(card, "Enter");
    document.removeEventListener("keydown", boardHandler);
    expect(boardHandler).not.toHaveBeenCalled();
  });

  it("ignores other keys", async () => {
    const onClick = vi.fn();
    const card = renderCard({ onClick });
    const event = await press(card, "a");
    expect(onClick).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });
});

describe("TaskCard, opening in a new tab", () => {
  it("leaves cmd+click to the browser", async () => {
    const onClick = vi.fn();
    const onSelect = vi.fn();
    const card = renderCard({ onClick, onSelect });
    const event = await click(card, { metaKey: true });
    expect(onClick).not.toHaveBeenCalled();
    expect(onSelect).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });

  it("leaves ctrl+click to the browser", async () => {
    const onClick = vi.fn();
    const onSelect = vi.fn();
    const card = renderCard({ onClick, onSelect });
    const event = await click(card, { ctrlKey: true });
    expect(onClick).not.toHaveBeenCalled();
    expect(onSelect).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });
});

describe("TaskCard selection", () => {
  it("toggles selection on shift+click instead of opening a window", async () => {
    const onClick = vi.fn();
    const onSelect = vi.fn();
    const card = renderCard({ onClick, onSelect });
    const event = await click(card, { shiftKey: true });
    expect(onSelect).toHaveBeenCalledWith("t1");
    expect(onClick).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(true);
  });

  it("toggles selection on shift+Enter", async () => {
    const onClick = vi.fn();
    const onSelect = vi.fn();
    const card = renderCard({ onClick, onSelect });
    await press(card, "Enter", { shiftKey: true });
    expect(onSelect).toHaveBeenCalledWith("t1");
    expect(onClick).not.toHaveBeenCalled();
  });

  it("selects on a plain click while selection mode is on", async () => {
    const onClick = vi.fn();
    const onSelect = vi.fn();
    const card = renderCard({ onClick, onSelect, selectionActive: true });
    await click(card);
    expect(onSelect).toHaveBeenCalledWith("t1");
    expect(onClick).not.toHaveBeenCalled();
  });

  it("opens the task on shift+click when the board has no selection", async () => {
    const onClick = vi.fn();
    const card = renderCard({ onClick });
    await click(card, { shiftKey: true });
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("keeps the checkbox outside the link so the card stays a valid link", async () => {
    const onSelect = vi.fn();
    renderCard({ onSelect, selectionActive: true });
    const checkbox = screen.getByRole("button", { name: "Select TP-7" });
    expect(checkbox.closest("a")).toBeNull();
    await click(checkbox);
    expect(onSelect).toHaveBeenCalledWith("t1");
  });
});

describe("TaskCard drag", () => {
  it("still hands the task id to the column", async () => {
    const card = renderCard();
    const payload = await dragStart(card);
    expect(payload.get("text/plain")).toBe("t1");
  });

  it("does not open the task on the click that can follow a drag", async () => {
    const onClick = vi.fn();
    const card = renderCard({ onClick });
    await mouseDown(card);
    await dragStart(card);
    const event = await click(card);
    expect(onClick).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(true);
  });

  it("opens again on the next press after a drag", async () => {
    const onClick = vi.fn();
    const card = renderCard({ onClick });
    await dragStart(card);
    await click(card);
    await mouseDown(card);
    await click(card);
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});
