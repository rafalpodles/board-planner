// @vitest-environment happy-dom
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
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
