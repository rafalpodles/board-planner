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
    difficulty: "M",
    category: "bug",
    component: "kanban-list-view",
    assignee: { _id: "u1", username: "rpo", fullName: "Rafał Podleś-Wojciechowski" },
    sprint: "s1",
    labels: [],
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
      "Difficulty",
      "Category",
      "Component",
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

  it("keeps the whole component reachable", () => {
    renderList();
    expect(screen.getByTitle("kanban-list-view").textContent).toBe("kanban-list-view");
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
