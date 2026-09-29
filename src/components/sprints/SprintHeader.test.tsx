// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, within } from "@testing-library/react";
import { SprintHeader } from "./SprintHeader";
import { ApiSprint } from "@/types";
import { pinTimezone } from "@/lib/testing/pin-timezone";

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

/**
 * BP-311. A board with no column carrying the `done` role resolves the done ids to `[]`, so
 * `doneCount` is 0 for every sprint for ever. Rendering that as `0/8` and an empty bar states
 * something about the sprint; the truth is about the board.
 */
describe("a board with no Done column", () => {
  it("says the progress cannot be measured, rather than reporting none", () => {
    renderHeader({ canMeasureDone: false });

    expect(screen.queryByTestId("sprint-progress")).toBeNull();
    expect(screen.getByTestId("sprint-progress-unmeasurable").textContent).toMatch(
      /no Done column/i
    );
  });

  // The control: an ordinary board is untouched, and 0 of 8 still reads as 0 of 8
  it("leaves a measurable sprint saying exactly what it did", () => {
    renderHeader();

    expect(screen.getByTestId("sprint-progress").textContent).toBe("4/8");
    expect(screen.queryByTestId("sprint-progress-unmeasurable")).toBeNull();
  });

  // The distinction the whole change rests on: nothing done is not the same as nothing countable
  it("still shows a real zero when the board CAN measure it", () => {
    renderHeader({ doneCount: 0, totalCount: 8 });

    expect(screen.getByTestId("sprint-progress").textContent).toBe("0/8");
    expect(screen.queryByTestId("sprint-progress-unmeasurable")).toBeNull();
  });
});

/**
 * BP-480. `daysLeft` has three branches and the boundary between "1 day left", "ends today" and
 * "1 day over" is where an off-by-one lands. BP-754: the end date is a picked day stored as its
 * UTC midnight, so the count is in calendar days from the viewer's today — read in Los Angeles at
 * 20:00, when UTC is already on tomorrow, which is where an instant-based count went wrong.
 *
 * Only `Date` is faked — faking timers as well would take React's scheduling with it.
 */
describe("the countdown", () => {
  pinTimezone("America/Los_Angeles");
  // Built when called, not when collected: the zone is pinned in `beforeAll`
  const evening = () => new Date(2026, 2, 10, 20, 0);
  const morning = () => new Date(2026, 2, 10, 0, 30);
  const day = (offset: number) =>
    new Date(Date.UTC(2026, 2, 10 + offset)).toISOString();

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(evening());
    expect(new Date().getUTCDate(), "the timezone did not actually change").toBe(11);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  /** The countdown sits in the header's own line; read the whole thing and look for the phrase */
  function countdown(endDate: string | null, props: Partial<React.ComponentProps<typeof SprintHeader>> = {}) {
    cleanup();
    renderHeader({
      // `endDate: null` is a sprint that never had one, which the type models as absent
      sprint: sprint({ _id: "f", name: "Sprint 6", status: "active", endDate: endDate ?? undefined }),
      ...props,
    });
    return document.body.textContent ?? "";
  }

  it("counts the days that are left", () => {
    expect(countdown(day(5))).toContain("5 days left");
  });

  it("says day, not days, for the last one", () => {
    expect(countdown(day(1))).toContain("1 day left");
    expect(countdown(day(2))).toContain("2 days left");
  });

  it("says it ends today all through its last day", () => {
    expect(countdown(day(0))).toContain("ends today");
    vi.setSystemTime(morning());
    expect(countdown(day(0))).toContain("ends today");
    expect(countdown(day(1))).toContain("1 day left");
  });

  it("counts the days it is over by, from the day after its last", () => {
    expect(countdown(day(-1))).toContain("1 day over");
    expect(countdown(day(-2))).toContain("2 days over");
  });

  it("dates its range by the days that were picked", () => {
    const text = countdown(null, {
      sprint: sprint({
        _id: "f",
        name: "Sprint 6",
        status: "active",
        startDate: "2026-01-01T00:00:00.000Z",
        endDate: "2026-01-15T00:00:00.000Z",
      }),
    });
    expect(text).toContain("Jan 1 — Jan 15, 2026");
  });

  /**
   * Not the sprint's `status`, which is what it looks like: the component reads `readOnly`, and
   * this page sets that from a completed sprint (`sprints/page.tsx`'s `sprintIsReadOnly`). So a
   * countdown on a finished sprint is a question about the prop, not about the record.
   */
  it("says nothing at all once the board is read-only", () => {
    const text = countdown(day(5), { readOnly: true });
    // Anchored: without this the assertions below are equally happy with a header that rendered
    // nothing at all, which is a different bug wearing this test's green
    expect(text).toContain("Sprint 6");
    expect(text).not.toContain("days left");
    expect(text).not.toContain("ends today");

    // The control, same sprint, same end date: without readOnly it does count
    expect(countdown(day(5))).toContain("5 days left");
  });

  it("says nothing at all for a sprint with no end date", () => {
    const text = countdown(null);
    expect(text).toContain("Sprint 6");
    expect(text).not.toContain("left");
    expect(text).not.toContain("ends today");
    expect(text).not.toContain("over");
  });

  /**
   * The guard between a bad date and `NaN days left` on somebody's board. Deleting it left all
   * twenty-four tests in this file green, so it was carried by nothing.
   */
  it("says nothing for an end date that is not a date", () => {
    const text = countdown("the fifteenth");
    expect(text).toContain("Sprint 6");
    expect(text).not.toContain("NaN");
    expect(text).not.toContain("left");
    expect(text).not.toContain("ends today");
  });
});
