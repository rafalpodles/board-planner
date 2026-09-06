// @vitest-environment happy-dom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, act } from "@testing-library/react";
import { BoardHeader } from "./BoardHeader";
import { ApiSprint } from "@/types";

const sprints = [
  { _id: "s1", name: "Sprint 12", status: "active" },
  { _id: "s2", name: "Sprint 13", status: "planned" },
  { _id: "s3", name: "Sprint 11", status: "completed" },
] as ApiSprint[];

function renderHeader(over: Partial<React.ComponentProps<typeof BoardHeader>> = {}) {
  return render(
    <BoardHeader
      projectName="Test Project"
      projectIcon="📋"
      sprints={sprints}
      scope="all"
      onScopeChange={() => {}}
      viewMode="board"
      onViewModeChange={() => {}}
      onRefresh={() => {}}
      onNewTask={() => {}}
      {...over}
    />
  );
}

afterEach(cleanup);

function classesOf(el: Element) {
  return [...el.classList];
}

const CONTAINER_MIN_WIDTH: Record<string, number> = {
  "@3xs": 256,
  "@2xs": 288,
  "@xs": 320,
  "@sm": 384,
  "@md": 448,
  "@lg": 512,
  "@xl": 576,
  "@2xl": 672,
  "@3xl": 768,
  "@4xl": 896,
};

const DISPLAY_UTILITIES = new Set([
  "hidden",
  "block",
  "inline",
  "inline-block",
  "flex",
  "inline-flex",
  "grid",
  "inline-grid",
  "contents",
]);

function displayAt(el: Element, boardWidth: number): string {
  let display = "inline";
  let from = -1;
  for (const cls of classesOf(el)) {
    const split = cls.lastIndexOf(":");
    const utility = split === -1 ? cls : cls.slice(split + 1);
    if (!DISPLAY_UTILITIES.has(utility)) continue;
    if (split === -1) {
      if (from <= 0) {
        display = utility;
        from = 0;
      }
      continue;
    }
    const variant = cls.slice(0, split);
    const min = CONTAINER_MIN_WIDTH[variant];
    if (min === undefined) {
      throw new Error(
        `"${cls}" is not a container query, so this spec cannot tell whether the element is on screen at a ${boardWidth}px board`
      );
    }
    if (boardWidth >= min && min >= from) {
      display = utility;
      from = min;
    }
  }
  return display;
}

function isOnScreen(el: Element, boardWidth: number): boolean {
  const header = el.closest("header");
  if (!header) throw new Error("the element is not inside the header");
  if (!classesOf(header).includes("@container")) {
    throw new Error("the header is no longer a query container, so every @-variant under it is dead");
  }
  for (let node: Element | null = el; node; node = node.parentElement) {
    if (displayAt(node, boardWidth) === "hidden") return false;
    if (node === header) break;
  }
  return true;
}

describe("BoardHeader", () => {
  it("names the project", () => {
    renderHeader();
    expect(screen.getByRole("heading", { name: "Test Project" })).toBeTruthy();
  });

  it("names the scope when unscoped", () => {
    renderHeader();
    expect(screen.getByLabelText("Change sprint scope").textContent).toBe("All tasks");
  });

  it("carries no board label, task count or done meter", () => {
    renderHeader();
    expect(screen.queryByText(/Board ·/)).toBeNull();
    expect(screen.queryByText(/\d+ tasks?$/)).toBeNull();
    expect(screen.queryByText("12/30")).toBeNull();
  });

  it("names the sprint in the subtitle when scoped", () => {
    renderHeader({ scope: "s1" });
    expect(screen.getByLabelText("Change sprint scope").textContent).toBe("Sprint 12");
  });

  it("names the backlog scope", () => {
    renderHeader({ scope: "backlog" });
    expect(screen.getByLabelText("Change sprint scope").textContent).toBe("Backlog");
  });

  it("shows no scope control at all for a project with no sprints", () => {
    renderHeader({ sprints: [] });
    expect(screen.queryByLabelText("Change sprint scope")).toBeNull();
  });

  it("offers all tasks, backlog, the active sprint and planned sprints", async () => {
    renderHeader();
    await act(async () => {
      screen.getByLabelText("Change sprint scope").click();
    });

    const menu = screen.getByRole("menu", { name: "Sprint scope" });
    const options = [...menu.querySelectorAll("button")].map((b) => b.textContent);
    expect(options).toEqual([
      "All tasks",
      "Backlog (no sprint)",
      "Sprint 12 (Active)",
      "Sprint 13",
    ]);
  });

  it("reports the chosen scope and closes the menu", async () => {
    const onScopeChange = vi.fn();
    renderHeader({ onScopeChange });

    await act(async () => {
      screen.getByLabelText("Change sprint scope").click();
    });
    await act(async () => {
      screen.getByText("Sprint 13").click();
    });

    expect(onScopeChange).toHaveBeenCalledWith("s2");
    expect(screen.queryByText("Backlog (no sprint)")).toBeNull();
  });

  it("truncates a long sprint name instead of letting it widen the header", () => {
    renderHeader({
      scope: "s4",
      sprints: [{ _id: "s4", name: "Sprint 2026-Q3 hardening and cleanup", status: "planned" } as ApiSprint],
    });
    const trigger = screen.getByLabelText("Change sprint scope");
    expect(trigger.className).toContain("truncate");
    expect(trigger.className).toContain("max-w-");
  });

  it("has exactly two view segments and marks the current one", () => {
    renderHeader({ viewMode: "list" });
    const board = screen.getByText("Board", { selector: "button" });
    const list = screen.getByText("List", { selector: "button" });
    expect(list.getAttribute("aria-current")).toBe("true");
    expect(board.getAttribute("aria-current")).toBeNull();
    expect(screen.queryByText("Timeline")).toBeNull();
  });

  it("reports a view switch", async () => {
    const onViewModeChange = vi.fn();
    renderHeader({ onViewModeChange });
    await act(async () => {
      screen.getByText("List", { selector: "button" }).click();
    });
    expect(onViewModeChange).toHaveBeenCalledWith("list");
  });

  it("wires refresh and new task", async () => {
    const onRefresh = vi.fn();
    const onNewTask = vi.fn();
    renderHeader({ onRefresh, onNewTask });

    await act(async () => {
      screen.getByLabelText("Refresh board").click();
    });
    await act(async () => {
      screen.getByText("New task").click();
    });

    expect(onRefresh).toHaveBeenCalledTimes(1);
    expect(onNewTask).toHaveBeenCalledTimes(1);
  });

  it("lets only the title block shrink", () => {
    const { container } = renderHeader();
    const header = container.querySelector("header")!;
    expect(header.className).toContain("h-14");
    const titleBlock = header.firstElementChild!;
    expect(titleBlock.className).toContain("min-w-0");
    expect(titleBlock.className).not.toContain("shrink-0");
  });
});

const PARTS: Record<string, () => Element> = {
  "project name": () => screen.getByRole("heading", { name: "Test Project" }),
  "scope control": () => screen.getByLabelText("Change sprint scope"),
  "view switcher": () => screen.getByText("List", { selector: "button" }),
  "new task button": () => screen.getByLabelText("New task"),
  "new task icon": () => screen.getByLabelText("New task").querySelector("svg")!,
  "new task label": () => screen.getByText("New task", { selector: "span" }),
  refresh: () => screen.getByLabelText("Refresh board"),
  "project icon": () => screen.getByText("📋"),
  "shortcut hint": () => screen.getByText("N"),
};

const ESSENTIAL = [
  "project name",
  "scope control",
  "view switcher",
  "new task button",
  "refresh",
];
const NEEDS_448 = ["project icon", "new task label"];
const NEEDS_576 = ["shortcut hint"];

const BOARD_WIDTHS = [
  { width: 343, is: "the board on a 375px phone", shows: [...ESSENTIAL, "new task icon"] },
  { width: 447, is: "one pixel short of room for the labels", shows: [...ESSENTIAL, "new task icon"] },
  { width: 448, is: "the width that buys back the labels", shows: [...ESSENTIAL, ...NEEDS_448] },
  { width: 476, is: "the board at 768px beside the sidebar", shows: [...ESSENTIAL, ...NEEDS_448] },
  { width: 575, is: "one pixel short of room for the trimmings", shows: [...ESSENTIAL, ...NEEDS_448] },
  { width: 576, is: "the width that buys back the trimmings", shows: [...ESSENTIAL, ...NEEDS_448, ...NEEDS_576] },
  { width: 731, is: "the board at 1023px beside the sidebar", shows: [...ESSENTIAL, ...NEEDS_448, ...NEEDS_576] },
];

describe("BoardHeader sheds by board width", () => {
  for (const { width, is, shows } of BOARD_WIDTHS) {
    it(`shows ${shows.length} of ${Object.keys(PARTS).length} parts at ${width}px, ${is}`, () => {
      renderHeader();
      const onScreen = Object.entries(PARTS)
        .filter(([, find]) => isOnScreen(find(), width))
        .map(([name]) => name);
      expect(onScreen.sort()).toEqual([...shows].sort());
    });
  }
});

const EVERY_THRESHOLD = [
  256, 288, 320, 343, 384, 447, 448, 476, 512, 575, 576, 672, 731, 768, 896, 1200,
];

describe("BoardHeader keeps what the board cannot be used without", () => {
  it("never hides the project name or the only control over sprint scope", () => {
    renderHeader();
    for (const width of EVERY_THRESHOLD) {
      expect([width, isOnScreen(PARTS["project name"](), width)]).toEqual([width, true]);
      expect([width, isOnScreen(PARTS["scope control"](), width)]).toEqual([width, true]);
    }
  });

  it("never hides the view switcher, the only way to reach the list", () => {
    renderHeader();
    for (const width of EVERY_THRESHOLD) {
      expect([width, isOnScreen(PARTS["view switcher"](), width)]).toEqual([width, true]);
    }
  });

  it("offers exactly one of the New task icon and its label at every width", () => {
    renderHeader();
    for (const width of EVERY_THRESHOLD) {
      const shown = [PARTS["new task icon"](), PARTS["new task label"]()].filter((el) =>
        isOnScreen(el, width)
      );
      expect([width, shown.length]).toEqual([width, 1]);
    }
  });
});
