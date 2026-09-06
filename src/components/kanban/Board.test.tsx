// @vitest-environment happy-dom
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, act, fireEvent } from "@testing-library/react";
import { Board } from "./Board";
import { ApiTask, ApiProjectCategory } from "@/types";
import { ApiProjectColumn } from "@/types";
import { pagedColumnOffset } from "@/lib/board-swipe";

const media = vi.hoisted(() => ({ phone: false }));
vi.mock("@/hooks/use-media-query", () => ({ useMediaQuery: () => media.phone }));

const columns: ApiProjectColumn[] = [
  { _id: "c1", id: "todo", label: "To Do", color: "#0ea5e9", role: "approved", order: 0, triggersPmReview: false },
];

const tasks = [
  {
    _id: "t1",
    taskNumber: 7,
    title: "A bug",
    status: "todo",
    priority: "medium",
    category: "bug",
    createdAt: "2026-08-01T00:00:00Z",
    updatedAt: "2026-08-01T00:00:00Z",
  },
] as ApiTask[];

const categories = [{ name: "bug", color: "#ef4444" }] as ApiProjectCategory[];

function renderBoard(projectCategories?: ApiProjectCategory[]) {
  return render(
    <Board
      tasks={tasks}
      projectKey="TP"
      columns={columns}
      projectCategories={projectCategories}
      onStatusChange={() => {}}
      onTaskClick={() => {}}
    />
  );
}

function card(container: HTMLElement) {
  const el = container.querySelector("[draggable]");
  if (!el) throw new Error("no card rendered");
  return el as HTMLElement;
}

afterEach(cleanup);

describe("Board category tinting", () => {
  it("carries the category colour down to the card", () => {
    const { container } = renderBoard(categories);
    const el = card(container);
    expect(el.className).toContain("cat-card");
    expect(el.style.getPropertyValue("--cat")).toBe("#ef4444");
  });

  it("falls back to the plain card when the project defines no colours", () => {
    const { container } = renderBoard([]);
    const el = card(container);
    expect(el.className).not.toContain("cat-card");
    expect(el.style.getPropertyValue("--cat")).toBe("");
  });

  it("falls back to the plain card when the prop is missing entirely", () => {
    const { container } = renderBoard(undefined);
    const el = card(container);
    expect(el.className).not.toContain("cat-card");
  });
});

describe("Board empty-column rail", () => {
  const twoColumns: ApiProjectColumn[] = [
    { _id: "c1", id: "todo", label: "To Do", color: "#0ea5e9", role: "approved", order: 0, triggersPmReview: false },
    { _id: "c2", id: "done", label: "Done", color: "#22c55e", role: "done", order: 1, triggersPmReview: false },
  ];

  function renderTwoColumnBoard(collapseEmptyColumns?: boolean) {
    return render(
      <Board
        tasks={tasks}
        projectKey="TP"
        columns={twoColumns}
        collapseEmptyColumns={collapseEmptyColumns}
        onStatusChange={() => {}}
        onTaskClick={() => {}}
      />
    );
  }

  const rail = (container: HTMLElement) =>
    container.querySelector('[title="Done — 0 tasks. Click to expand."]') as HTMLElement | null;

  it("starts the empty column as a rail and the populated one open", () => {
    const { container } = renderTwoColumnBoard();
    expect(rail(container)).toBeTruthy();
    expect(screen.queryByLabelText("Collapse To Do")).toBeNull();
  });

  it("round-trips between rail and open column", async () => {
    const { container } = renderTwoColumnBoard();

    for (let pass = 0; pass < 3; pass++) {
      await act(async () => {
        rail(container)!.click();
      });
      expect(rail(container)).toBeNull();

      await act(async () => {
        screen.getByLabelText("Collapse Done").click();
      });
      expect(rail(container)).toBeTruthy();
    }
  });

  it("leaves the empty column at full width when the preference is off", () => {
    const { container } = renderTwoColumnBoard(false);
    expect(rail(container)).toBeNull();
    const grid = container.querySelector("[style*='grid-template-columns']") as HTMLElement;
    expect(grid.style.gridTemplateColumns).toBe("minmax(0, 1fr) minmax(0, 1fr)");
  });

  it("offers no collapse control when the preference is off, since there is no rail to return to", () => {
    renderTwoColumnBoard(false);
    expect(screen.queryByLabelText("Collapse Done")).toBeNull();
  });

  it("keeps the expansion out of localStorage", async () => {
    const { container } = renderTwoColumnBoard();
    await act(async () => {
      rail(container)!.click();
    });
    expect(Object.keys(localStorage)).toHaveLength(0);
  });
});

describe("A read-only board", () => {
  const columnsWithInProgress: ApiProjectColumn[] = [
    { _id: "c1", id: "todo", label: "To Do", color: "#0ea5e9", role: "approved", order: 0, triggersPmReview: false },
    { _id: "c2", id: "in_progress", label: "In Progress", color: "#f59e0b", role: "active", order: 1, triggersPmReview: false },
  ];

  function renderReadOnlyBoard(overrides: {
    onTaskDrop?: (taskId: string, status: string, dropIndex: number) => void;
    onStatusChange?: (taskId: string, status: string) => void;
  } = {}) {
    return render(
      <Board
        tasks={tasks}
        projectKey="TP"
        columns={columnsWithInProgress}
        readOnly
        onStatusChange={overrides.onStatusChange ?? (() => {})}
        onTaskDrop={overrides.onTaskDrop}
        onTaskClick={() => {}}
      />
    );
  }

  it("does not offer a card as a drag source", () => {
    renderReadOnlyBoard();
    const el = screen.getByRole("link", { name: /A bug/i });
    expect(el.getAttribute("draggable")).toBe("false");
  });

  it("still lets a card be opened", () => {
    renderReadOnlyBoard();
    const el = screen.getByRole("link", { name: /A bug/i });
    expect(el.getAttribute("href")).toContain("/TP/tasks/");
  });

  it("still opens on a real click", async () => {
    const onTaskClick = vi.fn();
    render(
      <Board
        tasks={tasks}
        projectKey="TP"
        columns={columnsWithInProgress}
        readOnly
        onStatusChange={() => {}}
        onTaskClick={onTaskClick}
      />
    );
    const el = screen.getByRole("link", { name: /A bug/i });
    await act(async () => {
      fireEvent.click(el);
    });
    expect(onTaskClick).toHaveBeenCalledWith("t1");
  });

  it("drops nothing when a task is dragged onto a column", () => {
    const onTaskDrop = vi.fn();
    const onStatusChange = vi.fn();
    renderReadOnlyBoard({ onTaskDrop, onStatusChange });
    const column = screen.getByTestId("column-in_progress");
    fireEvent.drop(column, { dataTransfer: { getData: () => "t1" } });
    expect(onTaskDrop).not.toHaveBeenCalled();
    expect(onStatusChange).not.toHaveBeenCalled();
  });

  it("does not invite a drop into an empty column", () => {
    renderReadOnlyBoard();
    expect(screen.queryByText("Drop tasks here")).toBeNull();
  });

  it("does not preempt a native drag over a card, so an outside drop is not implicitly permitted", () => {
    renderReadOnlyBoard();
    const link = screen.getByRole("link", { name: /A bug/i });
    const cardDragTarget = link.closest(".relative")!.parentElement!;
    const notPrevented = fireEvent.dragOver(cardDragTarget);
    expect(notPrevented).toBe(true);
  });

  it("renders and ignores a drop with no onStatusChange at all", () => {
    const { container } = render(
      <Board
        tasks={tasks}
        projectKey="TP"
        columns={columnsWithInProgress}
        readOnly
        onTaskClick={() => {}}
      />
    );
    const column = screen.getByTestId("column-in_progress");
    expect(() =>
      fireEvent.drop(column, { dataTransfer: { getData: () => "t1" } })
    ).not.toThrow();
  });
});

describe("Board paged on a phone", () => {
  const PAGE_WIDTH = 390;

  const threeColumns: ApiProjectColumn[] = [
    { _id: "c1", id: "todo", label: "To Do", color: "#0ea5e9", role: "approved", order: 0, triggersPmReview: false },
    { _id: "c2", id: "in_progress", label: "In Progress", color: "#f59e0b", role: "active", order: 1, triggersPmReview: false },
    { _id: "c3", id: "done", label: "Done", color: "#22c55e", role: "done", order: 2, triggersPmReview: false },
  ];

  function touchEvent(
    type: "touchstart" | "touchmove" | "touchend" | "touchcancel",
    key: "touches" | "changedTouches",
    points: { clientX: number; clientY: number }[]
  ) {
    const event = new Event(type, { bubbles: true, cancelable: true });
    Object.defineProperty(event, key, { value: points });
    return event;
  }

  const START = { clientX: 300, clientY: 400 };

  function swipe(el: HTMLElement, dx: number, dy = 0, via?: number) {
    fireEvent(el, touchEvent("touchstart", "touches", [START]));
    if (via !== undefined) {
      fireEvent(el, touchEvent("touchmove", "touches", [{ clientX: START.clientX + via, clientY: START.clientY }]));
    }
    fireEvent(
      el,
      touchEvent("touchend", "changedTouches", [
        { clientX: START.clientX + dx, clientY: START.clientY + dy },
      ])
    );
  }

  function scrollRowTo(scroller: HTMLElement, left: number) {
    Object.defineProperty(scroller, "scrollLeft", { configurable: true, value: left });
    fireEvent.scroll(scroller);
  }

  function renderPhoneBoard() {
    const view = render(
      <Board
        tasks={tasks}
        projectKey="TP"
        columns={threeColumns}
        onStatusChange={() => {}}
        onTaskClick={() => {}}
      />
    );
    const scroller = view.container.querySelector(".overflow-x-auto") as HTMLElement;
    Object.defineProperty(scroller, "clientWidth", { configurable: true, value: PAGE_WIDTH });
    const scrollTo = vi.fn();
    scroller.scrollTo = scrollTo as unknown as typeof scroller.scrollTo;
    return { ...view, scroller, scrollTo };
  }

  const active = () =>
    screen.getByLabelText(/^Show /, { selector: "[aria-current]" }).getAttribute("aria-label");

  const scrolledTo = (index: number) => ({
    left: pagedColumnOffset(index, PAGE_WIDTH),
    behavior: "smooth",
  });

  beforeEach(() => {
    media.phone = true;
  });

  afterEach(() => {
    media.phone = false;
  });

  it("gives every column the whole screen", () => {
    const { container } = renderPhoneBoard();
    const grid = container.querySelector("[style*='grid-template-columns']") as HTMLElement;
    expect(grid.style.gridTemplateColumns).toBe("repeat(3, 100%)");
  });

  it("starts on the board's first column", () => {
    renderPhoneBoard();
    expect(active()).toBe("Show To Do");
  });

  it("brings the next column in on a flick to the left", () => {
    const { scroller, scrollTo } = renderPhoneBoard();
    swipe(scroller, -120);
    expect(scrollTo).toHaveBeenCalledWith(scrolledTo(1));
    expect(active()).toBe("Show In Progress");
  });

  it("goes back a column on a flick to the right", () => {
    const { scroller, scrollTo } = renderPhoneBoard();
    swipe(scroller, -120);
    swipe(scroller, 120);
    expect(scrollTo).toHaveBeenLastCalledWith(scrolledTo(0));
    expect(active()).toBe("Show To Do");
  });

  it("stops at the first column instead of looping to the last", () => {
    const { scroller, scrollTo } = renderPhoneBoard();
    swipe(scroller, 120);
    expect(scrollTo).toHaveBeenCalledWith(scrolledTo(0));
    expect(active()).toBe("Show To Do");
  });

  it("stops at the last column instead of looping to the first", () => {
    const { scroller, scrollTo } = renderPhoneBoard();
    swipe(scroller, -120);
    swipe(scroller, -120);
    swipe(scroller, -120);
    expect(scrollTo).toHaveBeenLastCalledWith(scrolledTo(2));
    expect(active()).toBe("Show Done");
  });

  it("leaves the board where it is when the drag is mostly vertical", () => {
    const { scroller, scrollTo } = renderPhoneBoard();
    swipe(scroller, -120, 300);
    expect(scrollTo).not.toHaveBeenCalled();
    expect(active()).toBe("Show To Do");
  });

  it("ignores a tap, which travels nowhere", () => {
    const { scroller, scrollTo } = renderPhoneBoard();
    swipe(scroller, -4);
    expect(scrollTo).not.toHaveBeenCalled();
  });

  it("jumps to the column whose dot is tapped", () => {
    const { scrollTo } = renderPhoneBoard();
    fireEvent.click(screen.getByLabelText("Show Done"));
    expect(scrollTo).toHaveBeenCalledWith(scrolledTo(2));
    expect(active()).toBe("Show Done");
  });

  it("follows the row when something else scrolls it", () => {
    const { scroller } = renderPhoneBoard();
    Object.defineProperty(scroller, "scrollLeft", {
      configurable: true,
      value: pagedColumnOffset(1, PAGE_WIDTH),
    });
    fireEvent.scroll(scroller);
    expect(active()).toBe("Show In Progress");
  });

  it("follows the row when something interrupts the scroll it asked for", () => {
    const { scroller } = renderPhoneBoard();

    swipe(scroller, -100);
    expect(active()).toBe("Show In Progress");

    scrollRowTo(scroller, pagedColumnOffset(0, PAGE_WIDTH));
    scrollRowTo(scroller, pagedColumnOffset(0, PAGE_WIDTH));

    expect(active(), "the dots kept naming a column that is not on screen").toBe("Show To Do");
  });

  it("does not skip a column on the flick after an interrupted one", () => {
    const { scroller, scrollTo } = renderPhoneBoard();

    swipe(scroller, -100);
    scrollRowTo(scroller, pagedColumnOffset(0, PAGE_WIDTH));
    scrollRowTo(scroller, pagedColumnOffset(0, PAGE_WIDTH));
    scrollTo.mockClear();

    swipe(scroller, -100);

    expect(scrollTo).toHaveBeenCalledWith(scrolledTo(1));
    expect(active()).toBe("Show In Progress");
  });

  it("ignores the positions a smooth scroll reports on its way", () => {
    const { scroller } = renderPhoneBoard();

    swipe(scroller, -100);
    scrollRowTo(scroller, 40);
    scrollRowTo(scroller, 200);

    expect(active()).toBe("Show In Progress");
  });

  it("stays put when the finger turns around and overshoots", () => {
    const { scroller, scrollTo } = renderPhoneBoard();

    swipe(scroller, 70, 0, -300);

    expect(scrollTo).not.toHaveBeenCalled();
    expect(active()).toBe("Show To Do");
  });

  it("abandons the gesture when the touch is cancelled", () => {
    const { scroller, scrollTo } = renderPhoneBoard();

    fireEvent(scroller, touchEvent("touchstart", "touches", [START]));
    fireEvent(scroller, touchEvent("touchcancel", "changedTouches", [START]));
    fireEvent(
      scroller,
      touchEvent("touchend", "changedTouches", [{ clientX: START.clientX - 200, clientY: START.clientY }])
    );

    expect(scrollTo).not.toHaveBeenCalled();
  });

  it("abandons the gesture when a second finger arrives", () => {
    const { scroller, scrollTo } = renderPhoneBoard();

    fireEvent(scroller, touchEvent("touchstart", "touches", [START]));
    fireEvent(scroller, touchEvent("touchmove", "touches", [START, { clientX: 100, clientY: 400 }]));
    fireEvent(
      scroller,
      touchEvent("touchend", "changedTouches", [{ clientX: START.clientX - 200, clientY: START.clientY }])
    );

    expect(scrollTo).not.toHaveBeenCalled();
  });

  it("tells the browser not to pan the row itself", () => {
    const { scroller } = renderPhoneBoard();
    expect(scroller.style.touchAction).toBe("pan-y pinch-zoom");
  });

  it("gives each dot a thumb-sized hit area", () => {
    renderPhoneBoard();
    const dot = screen.getByLabelText("Show To Do");
    expect(dot.className).toContain("min-h-11");
    expect(dot.className).toContain("min-w-11");
  });

});

describe("Board on a wide screen", () => {
  const twoColumns: ApiProjectColumn[] = [
    { _id: "c1", id: "todo", label: "To Do", color: "#0ea5e9", role: "approved", order: 0, triggersPmReview: false },
    { _id: "c2", id: "in_progress", label: "In Progress", color: "#f59e0b", role: "active", order: 1, triggersPmReview: false },
  ];

  it("has no column dots and keeps the side-by-side columns", () => {
    const { container } = render(
      <Board
        tasks={tasks}
        projectKey="TP"
        columns={twoColumns}
        collapseEmptyColumns={false}
        onStatusChange={() => {}}
        onTaskClick={() => {}}
      />
    );
    expect(screen.queryByLabelText("Show To Do")).toBeNull();
    const grid = container.querySelector("[style*='grid-template-columns']") as HTMLElement;
    expect(grid.style.gridTemplateColumns).toBe("minmax(0, 1fr) minmax(0, 1fr)");
  });
});
