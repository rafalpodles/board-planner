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
      view="board"
      onViewChange={noop}
      onActivate={noop}
      onComplete={noop}
      onEdit={noop}
      onDelete={noop}
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

describe("SprintHeader estimate", () => {
  it("shows nothing about estimates when none is given", () => {
    renderHeader();
    expect(screen.queryByTestId("sprint-estimate-progress")).toBeNull();
  });

  it("shows the estimate done and total beside the task counts, labelled with the designated field's own name", () => {
    renderHeader({ estimate: { total: 13, done: 5, label: "Story points" } });
    expect(screen.getByTestId("sprint-estimate-progress").textContent).toBe("5/13 Story points");
    expect(screen.getByTestId("sprint-progress").textContent).toBe("4/8");
  });

  it("shows a designated field's zero total rather than hiding it", () => {
    renderHeader({ estimate: { total: 0, done: 0, label: "Hours" } });
    expect(screen.getByTestId("sprint-estimate-progress").textContent).toBe("0/0 Hours");
  });

  it("rounds a floating-point sum for display instead of printing every trailing digit", () => {
    renderHeader({ estimate: { total: 20, done: 0.6000000000000001, label: "Story points" } });
    expect(screen.getByTestId("sprint-estimate-progress").textContent).toBe("0.6/20 Story points");
  });

  it("lets a long field name shrink and ellipsize instead of forcing the row to overflow", () => {
    renderHeader({ estimate: { total: 5, done: 2, label: "A".repeat(100) } });
    expect(screen.getByTestId("sprint-estimate-progress").className).toContain("truncate");
    expect(screen.getByTestId("sprint-estimate-progress").className).toContain("min-w-0");
  });
});

describe("SprintHeader view toggle", () => {
  it("offers Board and Planning when the sprint is not read-only", () => {
    renderHeader({ readOnly: false });
    expect(screen.getByRole("button", { name: "Board" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Planning" })).toBeTruthy();
  });

  it("withholds the toggle on a read-only sprint", () => {
    renderHeader({ readOnly: true });
    expect(screen.queryByRole("button", { name: "Board" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Planning" })).toBeNull();
  });

  it("reports the picked view", () => {
    const onViewChange = vi.fn();
    renderHeader({ onViewChange });

    fireEvent.click(screen.getByRole("button", { name: "Planning" }));

    expect(onViewChange).toHaveBeenCalledWith("planning");
  });
});

describe("a board with no Done column", () => {
  it("says the progress cannot be measured, rather than reporting none", () => {
    renderHeader({ canMeasureDone: false });

    expect(screen.queryByTestId("sprint-progress")).toBeNull();
    expect(screen.getByTestId("sprint-progress-unmeasurable").textContent).toMatch(
      /no Done column/i
    );
  });

  it("leaves a measurable sprint saying exactly what it did", () => {
    renderHeader();

    expect(screen.getByTestId("sprint-progress").textContent).toBe("4/8");
    expect(screen.queryByTestId("sprint-progress-unmeasurable")).toBeNull();
  });

  it("still shows a real zero when the board CAN measure it", () => {
    renderHeader({ doneCount: 0, totalCount: 8 });

    expect(screen.getByTestId("sprint-progress").textContent).toBe("0/8");
    expect(screen.queryByTestId("sprint-progress-unmeasurable")).toBeNull();
  });
});
