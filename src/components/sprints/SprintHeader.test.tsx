// @vitest-environment happy-dom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, within } from "@testing-library/react";
import { SprintHeader } from "./SprintHeader";
import { ApiSprint } from "@/types";

function sprint(over: Partial<ApiSprint> & { _id: string }): ApiSprint {
  return {
    name: over._id,
    startDate: "2026-01-01T00:00:00Z",
    endDate: "2026-01-15T00:00:00Z",
    goal: "",
    status: "planned",
    taskCount: 0,
    doneCount: 0,
    ...over,
  } as ApiSprint;
}

const many: ApiSprint[] = [
  sprint({ _id: "a", name: "Sprint 1", status: "completed" }),
  sprint({ _id: "b", name: "Sprint 2", status: "planned" }),
  sprint({ _id: "f", name: "Sprint 6", status: "active", taskCount: 8, doneCount: 4 }),
];

function noop() {}

function renderHeader(overrides: Partial<React.ComponentProps<typeof SprintHeader>> = {}) {
  const selected = overrides.sprint ?? many[2];
  return render(
    <SprintHeader
      sprint={selected}
      sprints={many}
      doneCount={4}
      totalCount={8}
      readOnly={false}
      onActivate={noop}
      onComplete={noop}
      onEdit={noop}
      onDelete={noop}
      onNewTask={noop}
      onSelectSprint={noop}
      {...overrides}
    />
  );
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("SprintHeader sprint picker", () => {
  it("lists every sprint grouped by status", () => {
    renderHeader();

    const select = screen.getByRole("combobox", { name: "Sprint" }) as HTMLSelectElement;
    expect(within(select).getByRole("group", { name: "Active" })).toBeTruthy();
    expect(within(select).getByRole("group", { name: "Planned" })).toBeTruthy();
    expect(within(select).getByRole("group", { name: "Completed" })).toBeTruthy();
    expect(within(select).getByRole("option", { name: "Sprint 6 · 4/8" })).toBeTruthy();
    expect(within(select).getByRole("option", { name: "Sprint 2 · 0/0" })).toBeTruthy();
    expect(within(select).getByRole("option", { name: "Sprint 1 · 0/0" })).toBeTruthy();
  });

  it("selects the current sprint's value", () => {
    renderHeader();
    const select = screen.getByRole("combobox", { name: "Sprint" }) as HTMLSelectElement;
    expect(select.value).toBe("f");
  });

  it("navigates when a different sprint is chosen", () => {
    const onSelectSprint = vi.fn();
    renderHeader({ onSelectSprint });

    const select = screen.getByRole("combobox", { name: "Sprint" });
    fireEvent.change(select, { target: { value: "b" } });

    expect(onSelectSprint).toHaveBeenCalledWith("b");
  });

  it("shows a chevron next to the heading when there is something to pick", () => {
    renderHeader();
    expect(screen.getByTestId("sprint-picker-chevron")).toBeTruthy();
  });

  it("hides the picker entirely when the project has only one sprint", () => {
    const onlySprint = sprint({ _id: "solo", name: "Solo Sprint", status: "active" });
    renderHeader({ sprint: onlySprint, sprints: [onlySprint] });

    expect(screen.queryByTestId("sprint-picker-chevron")).toBeNull();
    expect(screen.queryByRole("combobox", { name: "Sprint" })).toBeNull();
    expect(screen.getByText("Solo Sprint")).toBeTruthy();
  });

  it("still shows the heading text once, next to the chevron", () => {
    renderHeader();
    expect(screen.getByText("Sprint 6")).toBeTruthy();
  });
});
