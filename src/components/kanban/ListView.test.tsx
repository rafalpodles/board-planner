// @vitest-environment happy-dom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, act } from "@testing-library/react";
import { ListView } from "./ListView";
import { ApiSprint, ApiTask } from "@/types";

const sprints = [
  { _id: "s1", name: "Sprint 2026-Q3 hardening and cleanup", startDate: "2026-07-01", endDate: "2026-07-14", status: "completed" },
] as ApiSprint[];

const tasks = [
  {
    _id: "t1",
    taskNumber: 191,
    title: "Pages do not use the width the sidebar redesign freed up, and the list view scrolls sideways",
    status: "todo",
    priority: "medium",
    category: "bug",
    assignee: { _id: "u1", username: "rpo", fullName: "Rafał Podleś-Wojciechowski" },
    sprint: "s1",
    createdAt: "2026-08-01T00:00:00Z",
    updatedAt: "2026-08-01T00:00:00Z",
  },
] as unknown as ApiTask[];

function renderList(over: Partial<React.ComponentProps<typeof ListView>> = {}) {
  return render(
    <ListView tasks={tasks} projectKey="CP" sprints={sprints} onTaskClick={() => {}} {...over} />
  );
}

afterEach(cleanup);

describe("ListView columns", () => {
  it("still offers every column", () => {
    renderList();
    const headers = [...screen.getByRole("table").querySelectorAll("th")].map((th) =>
      th.textContent?.trim()
    );
    expect(headers).toEqual([
      "Key",
      "Title",
      "Status",
      "Assignee",
      "Priority",
      "Sprint",
      "Category",
      "Due",
      "Updated",
    ]);
  });

  it("keeps the body in step with the header, with and without the selection column", () => {
    const cellCounts = () => {
      const table = screen.getByRole("table");
      return {
        header: table.querySelectorAll("thead th").length,
        row: table.querySelector("tbody tr")!.querySelectorAll("td").length,
      };
    };

    renderList();
    const plain = cellCounts();
    expect(plain.row).toBe(plain.header);

    cleanup();
    renderList({ selectionMode: true });
    const selecting = cellCounts();
    expect(selecting.row).toBe(selecting.header);
    expect(selecting.header).toBe(plain.header + 1);
  });
});

describe("ListView truncated cells", () => {
  // Every capped column clips its text, so the full value has to stay reachable on hover
  it("keeps the whole title reachable", () => {
    renderList();
    expect(screen.getByTitle(tasks[0].title).textContent).toBe(tasks[0].title);
  });

  it("keeps the whole key reachable", () => {
    renderList();
    expect(screen.getByTitle("CP-191").textContent).toBe("CP-191");
  });

  it("keeps the whole assignee name reachable", () => {
    renderList();
    expect(screen.getByTitle("Rafał Podleś-Wojciechowski").textContent).toBe(
      "Rafał Podleś-Wojciechowski"
    );
  });

  it("keeps the whole sprint name reachable", () => {
    renderList();
    expect(screen.getByTitle(sprints[0].name).textContent).toBe(sprints[0].name);
  });

  it("keeps the whole category reachable", () => {
    renderList();
    expect(screen.getByTitle("bug").textContent).toBe("bug");
  });

  it("keeps the whole status label reachable as a badge", () => {
    renderList();
    expect(screen.getByTitle("To Do").textContent).toBe("To Do");
  });

  it("keeps the whole status label reachable as a picker", () => {
    renderList({ onStatusChange: () => {} });
    expect(screen.getByTitle("To Do").tagName).toBe("SELECT");
  });
});

// A row's status picker announced only its value, so nine of them on a page were
// nine identical "To Do" controls with no way to tell which task they belonged to
describe("ListView accessible names", () => {
  it("names the status picker by task and field", () => {
    renderList({ onStatusChange: () => {} });
    const select = screen.getByLabelText(
      "Status for CP-191: Pages do not use the width the sidebar redesign freed up, and the list view scrolls sideways"
    );
    expect(select.tagName).toBe("SELECT");
  });

  it("leaves no control in a row without an accessible name", () => {
    const { container } = renderList({ onStatusChange: () => {} });
    const unnamed = [...container.querySelectorAll("select, button")].filter(
      (el) => !el.getAttribute("aria-label") && !el.textContent?.trim() && !el.getAttribute("title")
    );
    expect(unnamed).toEqual([]);
  });
});

// The list used to re-sort its rows with private state, silently discarding the
// order the filter bar had just produced — the filter-bar sort control was inert
describe("ListView sort ownership", () => {
  const three = [3, 1, 2].map(
    (n) => ({ ...tasks[0], _id: `t${n}`, taskNumber: n, title: `Task ${n}` }) as ApiTask
  );

  function keysOnScreen(container: HTMLElement) {
    return [...container.querySelectorAll("tbody tr")].map((row) =>
      row.querySelector("td")?.textContent?.trim()
    );
  }

  it("renders the order it is given, however unsorted", () => {
    const { container } = render(
      <ListView tasks={three} projectKey="CP" sprints={sprints} onTaskClick={() => {}} />
    );
    expect(keysOnScreen(container)).toEqual(["CP-3", "CP-1", "CP-2"]);
  });

  it("does not quietly re-sort by key", () => {
    const { container } = render(
      <ListView
        tasks={three}
        projectKey="CP"
        sprints={sprints}
        sortField="priority"
        sortDir="desc"
        onSortChange={() => {}}
        onTaskClick={() => {}}
      />
    );
    expect(keysOnScreen(container)).not.toEqual(["CP-1", "CP-2", "CP-3"]);
  });

  it("asks its owner to sort instead of sorting itself", async () => {
    const onSortChange = vi.fn();
    renderList({ onSortChange, sortField: "manual", sortDir: "asc" });
    await act(async () => {
      screen.getByText("Priority").closest("button")!.click();
    });
    expect(onSortChange).toHaveBeenCalledWith("priority", "asc");
  });

  it("flips direction when the active column is clicked again", async () => {
    const onSortChange = vi.fn();
    renderList({ onSortChange, sortField: "priority", sortDir: "asc" });
    await act(async () => {
      screen.getByText("Priority").closest("button")!.click();
    });
    expect(onSortChange).toHaveBeenCalledWith("priority", "desc");
  });

  it("marks the active column with a direction arrow", () => {
    const { container } = render(
      <ListView
        tasks={tasks}
        projectKey="CP"
        sprints={sprints}
        sortField="priority"
        sortDir="desc"
        onSortChange={() => {}}
        onTaskClick={() => {}}
      />
    );
    const header = screen.getByText("Priority").closest("th")!;
    expect(header.querySelector("svg")).toBeTruthy();
    expect(container.querySelectorAll("th svg").length).toBe(1);
  });
});

describe("ListView column visibility", () => {
  const headers = () =>
    [...screen.getByRole("table").querySelectorAll("th")].map((th) => th.textContent?.trim());

  it("shows every column when nothing is hidden", () => {
    renderList();
    expect(headers()).toContain("Assignee");
    expect(headers()).toContain("Sprint");
  });

  it("renders neither the header nor the cells of a hidden column", () => {
    const { container } = renderList({ hiddenColumns: ["assignee", "sprint"] });
    expect(headers()).not.toContain("Assignee");
    expect(headers()).not.toContain("Sprint");
    // header row plus one body row, both narrowed by the same two columns
    const bodyCells = container.querySelectorAll("tbody tr:first-child td").length;
    expect(bodyCells).toBe(container.querySelectorAll("thead th").length);
  });

  it("keeps title and key even if a stored blob asks to hide them", () => {
    renderList({ hiddenColumns: ["title", "key"] as never });
    expect(headers()).toContain("Title");
    expect(headers()).toContain("Key");
  });

  // Hiding a column also removes its sort control, so the two must not disagree
  it("removes the sort control along with its column", () => {
    renderList({ hiddenColumns: ["priority"], onSortChange: () => {} });
    expect(screen.queryByLabelText("Sort by Priority")).toBeNull();
    expect(screen.getByLabelText("Sort by Title")).toBeTruthy();
  });
});

const roster = [
  { _id: "u1", username: "rpo", fullName: "Rafał Podleś-Wojciechowski" },
  { _id: "u2", username: "claude", fullName: "Claude Code" },
];

function assigneeSelect() {
  return screen.getByLabelText(/^Assignee for CP-191/) as HTMLSelectElement;
}

// The save settles in a microtask after the change event, so the act block has to
// be async or React reports the disabled-state update as unwrapped
async function pick(value: string) {
  const select = assigneeSelect();
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(select, value);
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

describe("ListView inline assignee", () => {
  it("stays read-only text without a handler", () => {
    renderList({ assignableUsers: roster });
    expect(screen.queryByLabelText(/^Assignee for/)).toBeNull();
    expect(screen.getByText("Rafał Podleś-Wojciechowski")).toBeTruthy();
  });

  // A member's user-list fetch 403s today, and an empty dropdown that silently
  // unassigns people is worse than the read-only cell they have now
  it("stays read-only text when the roster failed to load", () => {
    renderList({ assignableUsers: [], onAssigneeChange: vi.fn() });
    expect(screen.queryByLabelText(/^Assignee for/)).toBeNull();
    expect(screen.getByText("Rafał Podleś-Wojciechowski")).toBeTruthy();
  });

  it("offers every user plus Unassigned, with the current one selected", () => {
    renderList({ assignableUsers: roster, onAssigneeChange: vi.fn() });
    const select = assigneeSelect();
    expect([...select.options].map((o) => o.textContent)).toEqual([
      "Unassigned",
      "Rafał Podleś-Wojciechowski",
      "Claude Code",
    ]);
    expect(select.value).toBe("rpo");
  });

  it("reports the chosen username", async () => {
    const onAssigneeChange = vi.fn();
    renderList({ assignableUsers: roster, onAssigneeChange });
    await pick("claude");
    expect(onAssigneeChange).toHaveBeenCalledWith("t1", "claude");
  });

  it("reports an empty username when unassigned", async () => {
    const onAssigneeChange = vi.fn();
    renderList({ assignableUsers: roster, onAssigneeChange });
    await pick("");
    expect(onAssigneeChange).toHaveBeenCalledWith("t1", "");
  });

  // Losing project access does not unassign you, and a select whose value is not
  // among its options renders as the first one — quietly showing the wrong person
  it("keeps an assignee who is no longer in the roster", () => {
    renderList({ assignableUsers: [roster[1]], onAssigneeChange: vi.fn() });
    const select = assigneeSelect();
    expect(select.value).toBe("rpo");
    expect([...select.options].map((o) => o.value)).toContain("rpo");
  });

  // The roster fallback keyed off "not in the list", which an unassigned task also
  // satisfies — it appended a second, blank-labelled empty option below Unassigned
  it("offers exactly one empty option when nobody is assigned", () => {
    render(
      <ListView
        tasks={[{ ...tasks[0], assignee: null } as ApiTask]}
        projectKey="CP"
        sprints={sprints}
        onTaskClick={() => {}}
        assignableUsers={roster}
        onAssigneeChange={vi.fn()}
      />
    );
    const select = assigneeSelect();
    expect([...select.options].filter((o) => o.value === "")).toHaveLength(1);
    expect(select.value).toBe("");
    expect([...select.options].every((o) => o.textContent?.trim())).toBe(true);
  });

  it("disables the cell while the save is in flight", async () => {
    let release!: () => void;
    const onAssigneeChange = vi.fn(() => new Promise<void>((r) => (release = r)));
    renderList({ assignableUsers: roster, onAssigneeChange });

    const inFlight = pick("claude");
    expect(assigneeSelect().disabled).toBe(true);

    release();
    await inFlight;
    expect(assigneeSelect().disabled).toBe(false);
  });
});

describe("ListView reordering", () => {
  const many = [
    { ...tasks[0], _id: "t1", taskNumber: 1, title: "First" },
    { ...tasks[0], _id: "t2", taskNumber: 2, title: "Second" },
    { ...tasks[0], _id: "t3", taskNumber: 3, title: "Third" },
  ] as unknown as ApiTask[];

  function handles(container: HTMLElement) {
    return [...container.querySelectorAll('[draggable="true"]')] as HTMLElement[];
  }

  function rows(container: HTMLElement) {
    return [...container.querySelectorAll("tbody tr")] as HTMLElement[];
  }

  function drag(container: HTMLElement, fromIndex: number, toIndex: number) {
    const data = new Map<string, string>();
    const dataTransfer = {
      effectAllowed: "",
      dropEffect: "",
      setData: (k: string, v: string) => void data.set(k, v),
      getData: (k: string) => data.get(k) ?? "",
      setDragImage: () => {},
    };
    const fire = (el: HTMLElement, type: string) => {
      const event = new Event(type, { bubbles: true, cancelable: true });
      Object.defineProperty(event, "dataTransfer", { value: dataTransfer });
      el.dispatchEvent(event);
    };

    fire(handles(container)[fromIndex], "dragstart");
    fire(rows(container)[toIndex], "dragover");
    fire(rows(container)[toIndex], "drop");
  }

  it("offers a handle per row under manual sort", () => {
    const { container } = renderList({ tasks: many, onReorder: () => {} });
    expect(handles(container)).toHaveLength(3);
  });

  it("offers no handle without a reorder handler", () => {
    const { container } = renderList({ tasks: many });
    expect(handles(container)).toHaveLength(0);
  });

  // Any other sort recomputes the order on the next render, throwing the drop away
  it("offers no handle under any other sort", () => {
    const { container } = renderList({
      tasks: many,
      sortField: "priority",
      onReorder: () => {},
    });
    expect(handles(container)).toHaveLength(0);
  });

  it("offers no handle with a single row", () => {
    const { container } = renderList({ tasks: [many[0]], onReorder: () => {} });
    expect(handles(container)).toHaveLength(0);
  });

  it("reports every visible id in its new order on drop", async () => {
    const onReorder = vi.fn();
    const { container } = renderList({ tasks: many, onReorder });
    await act(async () => drag(container, 0, 2));
    expect(onReorder).toHaveBeenCalledWith(["t2", "t3", "t1"]);
  });

  it("reports nothing when a row is dropped on itself", async () => {
    const onReorder = vi.fn();
    const { container } = renderList({ tasks: many, onReorder });
    await act(async () => drag(container, 1, 1));
    expect(onReorder).not.toHaveBeenCalled();
  });
});
