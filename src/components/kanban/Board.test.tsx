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

  /** Moves the row the way anything other than `goToColumn` would, and reports it. */
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

  // The defect this guard was hiding: waiting only for the target to arrive left it wedged when
  // the animation was interrupted, and from then on the dots named a column that was not on
  // screen. Reproduced by moving the row somewhere else while a flick's scroll is in flight.
  it("follows the row when something interrupts the scroll it asked for", () => {
    const { scroller } = renderPhoneBoard();

    swipe(scroller, -100);
    expect(active()).toBe("Show In Progress");

    // Not the column it asked for, and then stuck there — a field scrolled into view, a URL bar
    scrollRowTo(scroller, pagedColumnOffset(0, PAGE_WIDTH));
    scrollRowTo(scroller, pagedColumnOffset(0, PAGE_WIDTH));

    expect(active(), "the dots kept naming a column that is not on screen").toBe("Show To Do");
  });

  // The consequence of the wedge, and the one a person actually sees: the next flick steps from
  // the stale index and jumps two columns.
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

  // The control for the two above: while the scroll really is closing on its target, the frames
  // on the way must NOT move the indicator, which is what the guard exists for
  it("ignores the positions a smooth scroll reports on its way", () => {
    const { scroller } = renderPhoneBoard();

    swipe(scroller, -100);
    scrollRowTo(scroller, 40);
    scrollRowTo(scroller, 200);

    expect(active()).toBe("Show In Progress");
  });

  // Peek at the next column and come back, overshooting the start: net displacement alone reads
  // that as a swipe the other way
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

  // A second finger arriving mid-drag is a pinch, and its travel says nothing about columns
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

  // The declaration the whole feature rests on with a real finger: without it the browser pans
  // the row itself, against the paging. Deletable with the entire suite green before this.
  it("tells the browser not to pan the row itself", () => {
    const { scroller } = renderPhoneBoard();
    expect(scroller.style.touchAction).toBe("pan-y pinch-zoom");
  });

  // These are the only pointer controls on the mobile board, and the app sizes such targets at
  // 44px everywhere else
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

  // The control for the paged tests: it catches a mis-wired *use* of the flag — paging that
  // ignores it and runs everywhere. It cannot catch a mis-wired query string, because the hook
  // is mocked in this file and the string is never evaluated: inverting `max-width` to
  // `min-width` leaves every test here green. Only the e2e, which sets a real viewport, sees it.
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

describe("Board in rows", () => {
  const two: ApiProjectColumn[] = [
    { _id: "c1", id: "todo", label: "To Do", color: "#0ea5e9", role: "approved", order: 0, triggersPmReview: false },
    { _id: "c2", id: "done", label: "Done", color: "#22c55e", role: "done", order: 1, triggersPmReview: false },
  ];
  const mk = (id: string, status: string, priority: string) =>
    ({ _id: id, taskNumber: Number(id.slice(1)), title: `Task ${id}`, status, priority, category: "bug", createdAt: "2026-08-01T00:00:00Z", updatedAt: "2026-08-01T00:00:00Z" }) as ApiTask;
  const all = [mk("t1", "todo", "urgent"), mk("t2", "todo", "low"), mk("t3", "done", "low")];
  const lanes = [
    { key: "v:urgent", label: "Urgent", tasks: [all[0]] },
    { key: "v:low", label: "Low", tasks: [all[1], all[2]] },
  ];

  function renderRows(over: Partial<React.ComponentProps<typeof Board>> = {}) {
    return render(
      <Board
        tasks={all}
        projectKey="TP"
        columns={two}
        lanes={lanes}
        laneGroupBy="priority"
        onStatusChange={() => {}}
        onTaskClick={() => {}}
        {...over}
      />
    );
  }

  it("draws a header per row, with its name and count, and a cell per row and column", () => {
    renderRows();
    const headers = screen.getAllByTestId("board-lane-header");
    expect(headers.map((h) => h.textContent)).toEqual(["Urgent1", "Low2"]);
    expect(screen.getAllByTestId("column-todo")).toHaveLength(2);
    expect(screen.getAllByTestId("column-done")).toHaveLength(2);
  });

  it("puts each task in the cell of its own row and column", () => {
    const { container } = renderRows();
    const cell = (lane: string, column: string) =>
      container.querySelector(`[data-testid="column-${column}"][data-lane="${lane}"]`)!;
    expect(cell("v:urgent", "todo").textContent).toContain("Task t1");
    expect(cell("v:urgent", "done").textContent).not.toContain("Task");
    expect(cell("v:low", "todo").textContent).toContain("Task t2");
    expect(cell("v:low", "done").textContent).toContain("Task t3");
  });

  it("draws rows in the order it is given them", () => {
    const { container } = renderRows({ lanes: [...lanes].reverse() });
    const order = [...container.querySelectorAll("[data-testid=board-lane-header]")].map((h) => h.getAttribute("data-lane"));
    expect(order).toEqual(["v:low", "v:urgent"]);
  });

  it("folds a row to its header: the cells go, the count stays, and the control says so", () => {
    renderRows({ collapsedLanes: new Set(["v:low"]) });
    const header = screen.getAllByTestId("board-lane-header")[1];
    expect(header.querySelector("button")!.getAttribute("aria-expanded")).toBe("false");
    expect(header.textContent).toBe("Low2");
    expect(screen.getAllByTestId("column-todo")).toHaveLength(1);
  });

  it("reports the row that was clicked", () => {
    const onToggleLane = vi.fn();
    renderRows({ onToggleLane });
    fireEvent.click(screen.getAllByTestId("board-lane-header")[0].querySelector("button")!);
    expect(onToggleLane).toHaveBeenCalledWith("v:urgent");
  });

  it("hands the row of the cell to a drop", () => {
    const onTaskDrop = vi.fn();
    const { container } = renderRows({ onTaskDrop });
    const target = container.querySelector('[data-testid="column-todo"][data-lane="v:low"]')!;
    const dataTransfer = { getData: () => "t1", dropEffect: "", setData: () => {} };
    fireEvent.dragEnter(target, { dataTransfer });
    fireEvent.dragOver(target, { dataTransfer });
    fireEvent.drop(target, { dataTransfer });
    expect(onTaskDrop).toHaveBeenCalledWith("t1", "todo", expect.any(Number), { groupBy: "priority", key: "v:low", label: "Low" });
  });

  it("is the one strip of columns it was without rows, or with none to draw", () => {
    const { rerender } = renderRows({ lanes: undefined, laneGroupBy: "" });
    expect(screen.queryAllByTestId("board-lane-header")).toHaveLength(0);
    expect(screen.getAllByTestId("column-todo")).toHaveLength(1);

    rerender(<Board tasks={all} projectKey="TP" columns={two} lanes={[]} laneGroupBy="priority" onStatusChange={() => {}} onTaskClick={() => {}} />);
    expect(screen.queryAllByTestId("board-lane-header")).toHaveLength(0);
    expect(screen.getAllByTestId("column-todo")).toHaveLength(1);
  });

  it("rails a column only when it is empty in every row, so the columns line up", () => {
    const { container } = renderRows({ collapseEmptyColumns: true });
    const cell = (lane: string, column: string) =>
      container.querySelector(`[data-testid="column-${column}"][data-lane="${lane}"]`)!;
    // Done is empty in the urgent row and holds t3 in the low one: a rail in neither
    expect(cell("v:urgent", "done").getAttribute("role")).toBe("group");
    expect(cell("v:low", "done").getAttribute("role")).toBe("group");

    cleanup();
    const alone = renderRows({ tasks: [all[0]], lanes: [lanes[0]], collapseEmptyColumns: true });
    const done = alone.container.querySelector('[data-testid="column-done"]')!;
    expect(done.getAttribute("role")).toBe("button");
  });

  it("offers to fold a column only when it is empty in every row, and always offers to open a rail", () => {
    const { container } = renderRows({ collapseEmptyColumns: true });
    // t3 is in done in the low row, so the empty urgent cell has no business offering to fold it
    const urgentDone = container.querySelector('[data-testid="column-done"][data-lane="v:urgent"]')!;
    expect(urgentDone.querySelector('button[aria-label^="Collapse"]')).toBeNull();

    cleanup();
    const alone = renderRows({ tasks: [all[0]], lanes: [lanes[0]], collapseEmptyColumns: true });
    expect(alone.container.querySelector('[data-testid="column-done"]')!.getAttribute("aria-label")).toBe("Expand Done");
  });

  it("counts in a row's header what its cells draw, leaving out a task on a column that is gone", () => {
    const orphan = mk("t9", "removed_column", "low");
    renderRows({ tasks: [...all, orphan], lanes: [lanes[0], { key: "v:low", label: "Low", tasks: [...lanes[1].tasks, orphan] }] });
    expect(screen.getAllByTestId("board-lane-count").map((c) => c.textContent)).toEqual(["1", "2"]);
  });

  it("names a row's control with its count in words", () => {
    renderRows();
    expect(screen.getByRole("button", { name: "Urgent, 1 task" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Low, 2 tasks" })).toBeTruthy();
  });

  it("keeps a column open for the whole drag, however many rows the pointer crosses, and folds it back when the drag ends", () => {
    const { container } = renderRows({ tasks: [all[0]], lanes: [lanes[0], { key: "v:low", label: "Low", tasks: [] }], collapseEmptyColumns: true });
    const doneCell = (lane: string) => container.querySelector(`[data-testid="column-done"][data-lane="${lane}"]`)!;
    expect(doneCell("v:urgent").getAttribute("role")).toBe("button");

    fireEvent.dragEnter(doneCell("v:urgent"));
    expect(doneCell("v:urgent").getAttribute("role")).toBe("group");
    fireEvent.dragLeave(doneCell("v:urgent"), { relatedTarget: document.body });
    expect(doneCell("v:low").getAttribute("role")).toBe("group");

    fireEvent.dragEnd(document);
    expect(doneCell("v:low").getAttribute("role")).toBe("button");
  });
});
