// @vitest-environment happy-dom
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, act, fireEvent } from "@testing-library/react";
import { Board } from "./Board";
import { ApiTask, ApiProjectCategory } from "@/types";
import { ApiProjectColumn } from "@/types";
import { pagedColumnOffset } from "@/lib/board-swipe";

// Every test below a desktop board unless it says otherwise
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
  // The board page silently stopped passing projectCategories during the (app)
  // route-group move, so every card lost its category colour while the list
  // view kept it. Nothing failed.
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

  // CP-174 made expanding one-way: pinning had no inverse, so the only way back was a reload
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
    // Full width, not a 44px slot
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

  // The href assertion above passes even if the click itself is swallowed — an
  // <a> still carries its href either way. Only a real click proves the card opens.
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

  // handleCardDragOver calls preventDefault unconditionally; under the native HTML5
  // DnD contract that is what permits a drop at that position — of anything, not just
  // an app card. With the column's own onDrop withheld, nothing downstream cancels the
  // browser's default handling, so a drag started outside the app (a file, a link) could
  // still be dropped over a card on a read-only board unless this per-card handler is
  // withheld too.
  it("does not preempt a native drag over a card, so an outside drop is not implicitly permitted", () => {
    renderReadOnlyBoard();
    const link = screen.getByRole("link", { name: /A bug/i });
    const cardDragTarget = link.closest(".relative")!.parentElement!;
    const notPrevented = fireEvent.dragOver(cardDragTarget);
    expect(notPrevented).toBe(true);
  });

  // onStatusChange is the one write prop that stays live on a completed sprint's board:
  // everything else is withheld through readOnly, so this is the prop that must be
  // withholdable too rather than papered over with a no-op callback
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

/**
 * BP-488. On a phone the columns are pages and a flick moves between them, because reaching the
 * next column by dragging a 200px-wide strip sideways is the gesture nobody makes.
 */
describe("Board paged on a phone", () => {
  const PAGE_WIDTH = 390;

  const threeColumns: ApiProjectColumn[] = [
    { _id: "c1", id: "todo", label: "To Do", color: "#0ea5e9", role: "approved", order: 0, triggersPmReview: false },
    { _id: "c2", id: "in_progress", label: "In Progress", color: "#f59e0b", role: "active", order: 1, triggersPmReview: false },
    { _id: "c3", id: "done", label: "Done", color: "#22c55e", role: "done", order: 2, triggersPmReview: false },
  ];

  // A plain Event carrying the fields React copies onto its synthetic touch event: happy-dom's
  // TouchEvent is not what is under test, and constructing one adds a dependency on it
  function touchEvent(
    type: "touchstart" | "touchend",
    key: "touches" | "changedTouches",
    points: { clientX: number; clientY: number }[]
  ) {
    const event = new Event(type, { bubbles: true, cancelable: true });
    Object.defineProperty(event, key, { value: points });
    return event;
  }

  const START = { clientX: 300, clientY: 400 };

  function swipe(el: HTMLElement, dx: number, dy = 0) {
    fireEvent(el, touchEvent("touchstart", "touches", [START]));
    fireEvent(
      el,
      touchEvent("touchend", "changedTouches", [
        { clientX: START.clientX + dx, clientY: START.clientY + dy },
      ])
    );
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
    // happy-dom lays nothing out, and both the page width and the scroll are what the
    // paging arithmetic is written against
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

  // The same finger scrolls a column's cards, and that gesture must not page the board
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

  // Swiping is additive: the indicator is still a way to pick a column outright
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
});

describe("Board on a wide screen", () => {
  const twoColumns: ApiProjectColumn[] = [
    { _id: "c1", id: "todo", label: "To Do", color: "#0ea5e9", role: "approved", order: 0, triggersPmReview: false },
    { _id: "c2", id: "in_progress", label: "In Progress", color: "#f59e0b", role: "active", order: 1, triggersPmReview: false },
  ];

  // The control for the paged tests: without it a mis-wired media query would look like a
  // working phone board and quietly page the desktop one too
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
