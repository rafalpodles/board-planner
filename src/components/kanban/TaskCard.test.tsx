// @vitest-environment happy-dom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, act } from "@testing-library/react";
import { TaskCard } from "./TaskCard";
import { ApiTask, ApiProjectCategory } from "@/types";

const task = {
  _id: "t1",
  taskNumber: 7,
  title: "A task",
  status: "todo",
  priority: "medium",
  category: "bug",
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

async function mouseDown(el: Element, init: MouseEventInit = {}) {
  const event = new MouseEvent("mousedown", { bubbles: true, cancelable: true, ...init });
  await act(async () => {
    el.dispatchEvent(event);
  });
  return event;
}

async function auxClick(el: Element, init: MouseEventInit = {}) {
  const event = new MouseEvent("auxclick", { bubbles: true, cancelable: true, ...init });
  await act(async () => {
    el.dispatchEvent(event);
  });
  return event;
}

// React runs every delegated handler from one listener on the node it was rooted
// at. Under the App Router that node is `document` — exactly where the board page
// registers its own keydown listener — so a listener added here reproduces the
// same-node collision that stopPropagation cannot resolve.
function reactRoot(el: Element): Element {
  for (let node: Element | null = el; node; node = node.parentElement) {
    if (Object.keys(node).some((k) => k.startsWith("__reactContainer"))) return node;
  }
  throw new Error("no React root container above the card — delegation topology changed");
}

afterEach(cleanup);

describe("TaskCard as a link", () => {
  it("points at the task page so it is tabbable and previewable", () => {
    const card = renderCard();
    expect(card.getAttribute("href")).toBe("/projects/TP/tasks/7");
    expect(card.hasAttribute("tabindex")).toBe(false);
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

  it("keeps Enter away from the board's own handler on the delegation node", async () => {
    const card = renderCard();
    const boardHandler = vi.fn();
    const root = reactRoot(card);
    root.addEventListener("keydown", boardHandler);
    await press(card, "Enter");
    root.removeEventListener("keydown", boardHandler);
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

  // A middle press fires mousedown then auxclick, never click, so the card must
  // leave both alone for the browser's own open-in-new-tab to survive
  it("leaves middle-click to the browser", async () => {
    const onClick = vi.fn();
    const onSelect = vi.fn();
    const card = renderCard({ onClick, onSelect });
    const down = await mouseDown(card, { button: 1 });
    const aux = await auxClick(card, { button: 1 });
    expect(down.defaultPrevented).toBe(false);
    expect(aux.defaultPrevented).toBe(false);
    expect(onClick).not.toHaveBeenCalled();
    expect(onSelect).not.toHaveBeenCalled();
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

  it("keeps the checkbox outside the link so the card stays a valid link", async () => {
    const onSelect = vi.fn();
    renderCard({ onSelect, selectionActive: true });
    const checkbox = screen.getByRole("button", { name: "Select TP-7" });
    expect(checkbox.closest("a")).toBeNull();
    await click(checkbox);
    expect(onSelect).toHaveBeenCalledWith("t1");
  });

  it("announces whether the card is selected, not just the checkbox name", () => {
    renderCard({ onSelect: vi.fn(), selectionActive: true });
    expect(screen.getByRole("button", { name: "Select TP-7", pressed: false })).toBeTruthy();
    cleanup();
    renderCard({ onSelect: vi.fn(), selected: true });
    expect(screen.getByRole("button", { name: "Select TP-7", pressed: true })).toBeTruthy();
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

describe("TaskCard execution state", () => {
  // Server-measured ages: asOf is when the payload was serialised, phaseAt the last report
  const asOf = "2026-08-01T12:00:00Z";
  const secondsAgo = (s: number) => new Date(Date.parse(asOf) - s * 1000).toISOString();

  const withRun = (execution: Record<string, unknown>) =>
    ({ ...task, execution: { asOf, ...execution } }) as ApiTask;

  const running = withRun({
    workerName: "mac-mini",
    phase: "agent",
    phaseAt: secondsAgo(30),
  });

  it("marks a card whose task a worker is running", () => {
    const card = renderCard({ task: running });
    expect(card.className).toContain("task-running");
    expect(screen.getByTestId("card-run-live")).toBeTruthy();
    expect(screen.getByText("agent")).toBeTruthy();
  });

  it("names the worker and phase without opening the task", () => {
    renderCard({ task: running });
    expect(screen.getByTestId("card-run-live").getAttribute("title")).toBe(
      "Being executed — mac-mini · agent"
    );
  });

  // A worker that has claimed but not yet reported still holds the task
  it("shows a claimed run that has not reported a phase yet", () => {
    renderCard({ task: withRun({ workerId: "w1" }) });
    expect(screen.getByText("starting")).toBeTruthy();
    expect(screen.getByTestId("card-run-live")).toBeTruthy();
  });

  it("says nothing when no run holds the task", () => {
    const card = renderCard();
    expect(card.className).not.toContain("task-running");
    expect(screen.queryByTestId("card-run-live")).toBeNull();
    expect(screen.queryByTestId("card-run-quiet")).toBeNull();
  });

  // The run holds the task for up to two hours; a worker that died mid-run keeps its runId
  // that whole time, so elapsed silence — not the field's presence — decides "live"
  it("stops calling a run live once the worker goes quiet", () => {
    const card = renderCard({
      task: withRun({ workerName: "mac-mini", phase: "agent", phaseAt: secondsAgo(20 * 60) }),
    });
    expect(screen.queryByTestId("card-run-live")).toBeNull();
    expect(screen.getByTestId("card-run-quiet")).toBeTruthy();
    expect(card.className).toContain("run-quiet");
    expect(screen.getByTestId("card-run-quiet").getAttribute("title")).toBe(
      "No sign of life — mac-mini · agent"
    );
  });

  it("still calls a run live just under the quiet threshold", () => {
    renderCard({ task: withRun({ phase: "agent", phaseAt: secondsAgo(4 * 60) }) });
    expect(screen.getByTestId("card-run-live")).toBeTruthy();
  });

  it("treats a freshly claimed run as live before its first report", () => {
    renderCard({ task: withRun({ workerId: "w1", phaseAt: null, startedAt: secondsAgo(30) }) });
    expect(screen.getByTestId("card-run-live")).toBeTruthy();
  });

  // Phase events are fire-and-forget, so a worker can claim a task and die before reporting.
  // Measuring silence from the claim is what stops the card lying for the whole lease.
  it("calls a claimed run quiet when it never reported and the claim is old", () => {
    renderCard({ task: withRun({ workerId: "w1", phaseAt: null, startedAt: secondsAgo(30 * 60) }) });
    expect(screen.getByTestId("card-run-quiet")).toBeTruthy();
    expect(screen.queryByTestId("card-run-live")).toBeNull();
  });

  // Asserts the class list only. The cascade — whether the run outline lets `border-primary`
  // and `.cat-card` survive — is what actually broke once, and happy-dom loads no stylesheet,
  // so nothing here can catch a repeat. Kept because losing a class from the list is its own
  // regression; deliberately NOT named as if it guarded the cascade.
  it("emits the run class alongside the selected and category classes", () => {
    const selectedCard = renderCard({ task: running, selected: true });
    expect(selectedCard.className).toContain("task-running");
    expect(selectedCard.className).toContain("border-primary");
    cleanup();

    const tintedCard = renderCard({
      task: running,
      projectCategories: [{ name: "bug", color: "#ff0000" }] as unknown as ApiProjectCategory[],
    });
    expect(tintedCard.className).toContain("task-running");
    expect(tintedCard.className).toContain("cat-card");
  });
});

describe("TaskCard context menu", () => {
  it("opens the app menu and suppresses the browser's own", async () => {
    const onContextMenu = vi.fn();
    const card = renderCard({ onContextMenu });
    const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 5, clientY: 9 });
    await act(async () => {
      card.dispatchEvent(event);
    });
    expect(onContextMenu).toHaveBeenCalledWith("t1", 5, 9);
    expect(event.defaultPrevented).toBe(true);
  });

  // A read-only board withholds onContextMenu entirely (rather than passing a no-op), so a
  // card offers no app menu — but it must not also swallow the browser's own (open in new
  // tab, copy link) by preventing default with nothing to show in its place.
  it("leaves the browser's own menu alone when no handler is given", async () => {
    const card = renderCard();
    const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    await act(async () => {
      card.dispatchEvent(event);
    });
    expect(event.defaultPrevented).toBe(false);
  });
});
