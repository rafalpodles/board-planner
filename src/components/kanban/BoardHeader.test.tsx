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
      taskCount={30}
      doneCount={12}
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

describe("BoardHeader", () => {
  it("names the project", () => {
    renderHeader();
    expect(screen.getByRole("heading", { name: "Test Project" })).toBeTruthy();
  });

  it("reads Board · N tasks when unscoped", () => {
    renderHeader();
    expect(screen.getByLabelText("Change sprint scope").textContent).toBe("All tasks");
    expect(screen.getByText(/30 tasks/)).toBeTruthy();
  });

  it("names the sprint in the subtitle when scoped", () => {
    renderHeader({ scope: "s1", taskCount: 8 });
    expect(screen.getByLabelText("Change sprint scope").textContent).toBe("Sprint 12");
    expect(screen.getByText(/8 tasks/)).toBeTruthy();
  });

  it("names the backlog scope", () => {
    renderHeader({ scope: "backlog" });
    expect(screen.getByLabelText("Change sprint scope").textContent).toBe("Backlog");
  });

  it("says one task, not 1 tasks", () => {
    renderHeader({ taskCount: 1, sprints: [] });
    expect(screen.getByText("Board · 1 task")).toBeTruthy();
  });

  // Matches SprintSelector returning null when a project has no sprints
  it("shows no scope control at all for a project with no sprints", () => {
    renderHeader({ sprints: [] });
    expect(screen.queryByLabelText("Change sprint scope")).toBeNull();
    expect(screen.getByText("Board · 30 tasks")).toBeTruthy();
  });

  it("offers all tasks, backlog, the active sprint and planned sprints", async () => {
    renderHeader();
    await act(async () => {
      screen.getByLabelText("Change sprint scope").click();
    });

    const menu = screen.getByRole("menu", { name: "Sprint scope" });
    const options = [...menu.querySelectorAll("button")].map((b) => b.textContent);
    // Completed sprints stay out, as they did in SprintSelector
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

  it("shows the done meter against the total", () => {
    renderHeader();
    expect(screen.getByText("12/30")).toBeTruthy();
  });

  it("hides the meter on an empty board", () => {
    renderHeader({ taskCount: 0, doneCount: 0 });
    expect(screen.queryByText("0/0")).toBeNull();
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

  // The title block is the only element allowed to shrink; everything else is fixed
  it("lets only the title block shrink", () => {
    const { container } = renderHeader();
    const header = container.querySelector("header")!;
    expect(header.className).toContain("h-14");
    const titleBlock = header.firstElementChild!;
    expect(titleBlock.className).toContain("min-w-0");
    expect(titleBlock.className).not.toContain("shrink-0");
  });
});
