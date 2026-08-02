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

describe("ListView column widths", () => {
  it("still offers every column at desktop width", () => {
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

  // A long title used to force the table past its container, cutting off "Updated"
  it("gives the leftover width to the title and lets it shrink to nothing", () => {
    renderList();
    const titleCell = screen.getByText(tasks[0].title).closest("td")!;
    expect(titleCell.className).toContain("w-full");
    expect(titleCell.className).toContain("max-w-0");
    expect(screen.getByText(tasks[0].title).className).toContain("truncate");

    const titleHeader = screen.getByText("Title").closest("th")!;
    expect(titleHeader.className).toContain("w-full");
  });

  it("caps the free-text columns so long values cannot widen the table", () => {
    renderList();
    const assignee = screen.getByText("Rafał Podleś-Wojciechowski");
    expect(assignee.className).toContain("truncate");
    expect(assignee.closest("td")!.className).toContain("max-w-");

    const sprint = screen.getByText("Sprint 2026-Q3 hardening and cleanup");
    expect(sprint.className).toContain("truncate");
    expect(sprint.closest("td")!.className).toContain("max-w-");

    const component = screen.getByText("kanban-list-view");
    expect(component.className).toContain("truncate");
    expect(component.closest("td")!.className).toContain("max-w-");
  });
});
