// @vitest-environment happy-dom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, act } from "@testing-library/react";
import { ListView } from "./ListView";
import { ApiCustomField, ApiSprint, ApiTask } from "@/types";

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

  // The cell shows initials to save width, so the name has to survive on the title
  it("keeps the whole assignee name reachable", () => {
    renderList();
    expect(screen.getByTitle("Rafał Podleś-Wojciechowski")).toBeTruthy();
    expect(screen.getByText("RP")).toBeTruthy();
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

  // Was an assertion on tagName === "SELECT"; the control is a combobox now, and the
  // full label still has to survive on a title because the trigger truncates
  it("keeps the whole status label reachable as a picker", () => {
    renderList({ onStatusChange: () => {} });
    expect(screen.getByTitle("To Do").textContent).toBe("To Do");
    expect(
      screen.getByRole("combobox", { name: /^Status for CP-191/ })
    ).toBeTruthy();
  });
});

// A row's status picker announced only its value, so nine of them on a page were
// nine identical "To Do" controls with no way to tell which task they belonged to
describe("ListView accessible names", () => {
  it("names the status picker by task and field", () => {
    renderList({ onStatusChange: () => {} });
    const trigger = screen.getByLabelText(
      "Status for CP-191: Pages do not use the width the sidebar redesign freed up, and the list view scrolls sideways"
    );
    expect(trigger.getAttribute("role")).toBe("combobox");
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

function assigneeTrigger() {
  return screen.getByRole("combobox", { name: /^Assignee for CP-191/ }) as HTMLButtonElement;
}

function openAssignee() {
  act(() => assigneeTrigger().click());
  return [...screen.getAllByRole("option")] as HTMLButtonElement[];
}

function optionLabels() {
  return openAssignee().map((o) => o.textContent?.replace("✓", "").trim());
}

// The save settles in a microtask after the click, so the act block has to be async
// or React reports the disabled-state update as unwrapped
async function pick(label: string) {
  const option = openAssignee().find((o) => o.textContent?.replace("✓", "").trim() === label);
  if (!option) throw new Error(`no option ${label}`);
  await act(async () => {
    option.click();
  });
}

describe("ListView inline assignee", () => {
  it("stays a read-only avatar without a handler", () => {
    renderList({ assignableUsers: roster });
    expect(screen.queryByRole("combobox", { name: /^Assignee for/ })).toBeNull();
    expect(screen.getByText("RP")).toBeTruthy();
  });

  // A member's user-list fetch 403s today, and an empty dropdown that silently
  // unassigns people is worse than the read-only cell they have now
  it("stays a read-only avatar when the roster failed to load", () => {
    renderList({ assignableUsers: [], onAssigneeChange: vi.fn() });
    expect(screen.queryByRole("combobox", { name: /^Assignee for/ })).toBeNull();
    expect(screen.getByText("RP")).toBeTruthy();
  });

  it("offers every user plus Unassigned, with the current one selected", () => {
    renderList({ assignableUsers: roster, onAssigneeChange: vi.fn() });
    expect(optionLabels()).toEqual([
      "Unassigned",
      "Rafał Podleś-Wojciechowski",
      "Claude Code",
    ]);
    const selected = screen.getAllByRole("option").filter((o) => o.getAttribute("aria-selected") === "true");
    expect(selected.map((o) => o.textContent?.replace("✓", "").trim())).toEqual([
      "Rafał Podleś-Wojciechowski",
    ]);
  });

  it("reports the chosen username", async () => {
    const onAssigneeChange = vi.fn();
    renderList({ assignableUsers: roster, onAssigneeChange });
    await pick("Claude Code");
    expect(onAssigneeChange).toHaveBeenCalledWith("t1", "claude");
  });

  it("reports an empty username when unassigned", async () => {
    const onAssigneeChange = vi.fn();
    renderList({ assignableUsers: roster, onAssigneeChange });
    await pick("Unassigned");
    expect(onAssigneeChange).toHaveBeenCalledWith("t1", "");
  });

  // Losing project access does not unassign you, and a select whose value is not
  // among its options renders as the first one — quietly showing the wrong person
  it("keeps an assignee who is no longer in the roster", () => {
    renderList({ assignableUsers: [roster[1]], onAssigneeChange: vi.fn() });
    expect(optionLabels()).toContain("rpo");
    const selected = screen.getAllByRole("option").filter((o) => o.getAttribute("aria-selected") === "true");
    expect(selected).toHaveLength(1);
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
    const labels = optionLabels();
    expect(labels.filter((l) => l === "Unassigned")).toHaveLength(1);
    expect(labels.every((l) => l)).toBe(true);
  });

  it("disables the cell while the save is in flight", async () => {
    let release!: () => void;
    const onAssigneeChange = vi.fn(() => new Promise<void>((r) => (release = r)));
    renderList({ assignableUsers: roster, onAssigneeChange });

    const option = openAssignee().find((o) => o.textContent?.includes("Claude Code"));
    await act(async () => option?.click());
    expect(assigneeTrigger().disabled).toBe(true);

    await act(async () => release());
    expect(assigneeTrigger().disabled).toBe(false);
  });
});

describe("ListView reordering", () => {
  const many = [
    { ...tasks[0], _id: "t1", taskNumber: 1, title: "First" },
    { ...tasks[0], _id: "t2", taskNumber: 2, title: "Second" },
    { ...tasks[0], _id: "t3", taskNumber: 3, title: "Third" },
  ] as unknown as ApiTask[];

  // The drag itself belongs to dnd-kit and needs real pointer geometry, which this
  // environment cannot provide; the order a drop produces is covered in reorder.test
  function handles() {
    return screen.queryAllByLabelText(/^Reorder /);
  }

  it("offers a handle per row under manual sort", () => {
    renderList({ tasks: many, onReorder: () => {} });
    expect(handles()).toHaveLength(3);
  });

  it("names each handle after its own row", () => {
    renderList({ tasks: many, onReorder: () => {} });
    expect(handles().map((h) => h.getAttribute("aria-label"))).toEqual([
      "Reorder CP-1",
      "Reorder CP-2",
      "Reorder CP-3",
    ]);
  });

  it("offers no handle without a reorder handler", () => {
    renderList({ tasks: many });
    expect(handles()).toHaveLength(0);
  });

  // Any other sort recomputes the order on the next render, throwing the drop away
  it("offers no handle under any other sort", () => {
    renderList({ tasks: many, sortField: "priority", onReorder: () => {} });
    expect(handles()).toHaveLength(0);
  });

  // Descending manual reverses the rows, so a drop would reindex them backwards
  it("offers no handle under descending manual order", () => {
    renderList({ tasks: many, sortDir: "desc", onReorder: () => {} });
    expect(handles()).toHaveLength(0);
  });

  it("offers no handle with a single row", () => {
    renderList({ tasks: [many[0]], onReorder: () => {} });
    expect(handles()).toHaveLength(0);
  });
});

// The stored value is the option's id, and since CP-211 that id is a generated
// "<slug>-<random>" — nothing like the label. Sending the label is a 400 from
// validateCustomFieldValues, and legacy string options hide it because id === value.
describe("ListView custom field picker", () => {
  const field = {
    _id: "f1",
    name: "Component",
    fieldType: "dropdown",
    options: [
      { id: "ui-a1b2c3", value: "ui", color: "#ff0000", order: 1 },
      { id: "backend-d4e5", value: "backend", color: "#00ff00", order: 2 },
    ],
    required: false,
    order: 1,
    showOnCard: false,
    showInList: true,
    filterable: true,
    archived: false,
  } as unknown as ApiCustomField;

  const withValue = [
    { ...tasks[0], _id: "t1", customFieldValues: { f1: "ui-a1b2c3" } },
  ] as unknown as ApiTask[];

  it("sends the option id, not its label", async () => {
    const onFieldChange = vi.fn();
    renderList({ tasks: withValue, customFields: [field], onFieldChange });

    act(() => {
      screen.getByRole("combobox", { name: /^Component for/ }).click();
    });
    const option = screen
      .getAllByRole("option")
      .find((o) => o.textContent?.replace("✓", "").trim() === "backend");
    await act(async () => option?.click());

    expect(onFieldChange).toHaveBeenCalledWith("t1", "f1", "backend-d4e5");
  });

  it("paints the chosen option in its own colour", () => {
    renderList({ tasks: withValue, customFields: [field], onFieldChange: vi.fn() });
    const badge = screen.getByText("ui").closest("span[style]");
    expect(badge?.getAttribute("style")).toContain("#ff0000");
  });
});

// CP-235 follow-up. The list showed nothing at all: the only way to learn a worker held a task
// was to try to move it and be refused.
describe("ListView, a task a worker is running", () => {
  const asOf = "2026-08-01T12:00:00Z";
  const secondsAgo = (s: number) => new Date(Date.parse(asOf) - s * 1000).toISOString();

  const withRun = (execution: Record<string, unknown>) => [
    { ...tasks[0], execution: { asOf, ...execution } },
    ...tasks.slice(1),
  ];

  it("marks the row a run holds", () => {
    renderList({
      tasks: withRun({ workerName: "mac-mini", phase: "agent", phaseAt: secondsAgo(30) }) as never,
    });
    const dot = screen.getByTestId("row-run-live");
    expect(dot).toBeTruthy();
    expect(dot.getAttribute("title")).toBe("Being executed — mac-mini · agent");
  });

  it("stops calling it live once the worker goes quiet", () => {
    renderList({
      tasks: withRun({ workerName: "mac-mini", phase: "agent", phaseAt: secondsAgo(20 * 60) }) as never,
    });
    expect(screen.getByTestId("row-run-quiet")).toBeTruthy();
    expect(screen.queryByTestId("row-run-live")).toBeNull();
  });

  it("says nothing when no run holds the task", () => {
    renderList();
    expect(screen.queryByTestId("row-run-live")).toBeNull();
    expect(screen.queryByTestId("row-run-quiet")).toBeNull();
  });
});
