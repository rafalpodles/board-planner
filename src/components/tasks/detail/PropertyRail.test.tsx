// @vitest-environment happy-dom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, act, fireEvent } from "@testing-library/react";
import { PropertyRail } from "./PropertyRail";
import type { TaskDraft } from "./useTaskEditor";
import { ApiCustomField, ApiSprint, ApiTask, ApiUser } from "@/types";

// The Agent row is the only one whose editability depends on the viewer (BP-345), so the rail now
// reads auth. Default to admin, which is what every other test here assumes it can click.
const isAdmin = vi.hoisted(() => ({ value: true }));
vi.mock("@/hooks/use-auth", () => ({ useAuth: () => ({ isAdmin: isAdmin.value }) }));

afterEach(() => {
  cleanup();
  isAdmin.value = true;
});

const draft: TaskDraft = {
  title: "A task",
  description: "",
  priority: "medium",
  category: "user-story",
  assignee: null,
  dueDate: null,
  checklist: [],
  sprint: null,
  agent: null,
  recurrence: null,
  customFieldValues: {},
};

const users = [
  { _id: "u1", username: "rpo", fullName: "Rafal Podles" },
  { _id: "u2", username: "claude", fullName: "Claude Code" },
] as ApiUser[];

const sprints = [
  { _id: "s1", name: "Sprint 14", status: "active" },
  { _id: "s2", name: "Sprint 13", status: "completed" },
] as ApiSprint[];

function field(over: Partial<ApiCustomField>): ApiCustomField {
  return {
    _id: "f1",
    name: "Team",
    fieldType: "dropdown",
    options: [{ id: "o1", value: "Platform", color: "#888", order: 0 }],
    required: false,
    order: 0,
    showOnCard: false,
    showInList: false,
    filterable: false,
    archived: false,
    ...over,
  } as ApiCustomField;
}

function renderRail(over: Partial<React.ComponentProps<typeof PropertyRail>> = {}) {
  const set = vi.fn();
  render(
    <PropertyRail
      draft={draft}
      set={set}
      users={users}
      sprints={sprints}
      agents={[]}
      categories={[
        { _id: "c1", name: "user-story", color: "#3b82f6" },
        { _id: "c2", name: "bug", color: "#ef4444" },
      ]}
      customFields={[]}
      stored={{ agent: null, assignee: null, assignedBy: null }}
      reporter="Claude Code"
      onDelete={() => {}}
      {...over}
    />
  );
  return set;
}

// Picker rows are comboboxes; the two that open something other than a list of options
// — Due date, Repeats — stay plain buttons
async function openRow(label: string | RegExp) {
  const row = [...screen.getAllByRole("combobox"), ...screen.getAllByRole("button")].find((b) =>
    typeof label === "string" ? b.textContent?.startsWith(label) : label.test(b.textContent || "")
  );
  await act(async () => row!.click());
  return row!;
}

async function pick(name: RegExp) {
  const option = screen.getAllByRole("option").find((o) => name.test(o.textContent || ""));
  await act(async () => option!.click());
}

describe("PropertyRail", () => {
  it("edits the assignee by username, which is what the API takes", async () => {
    const set = renderRail();
    await openRow("Assignee");
    await pick(/Rafal Podles/);
    expect(set).toHaveBeenCalledWith("assignee", "rpo");
  });

  it("clears the assignee to null rather than an empty string", async () => {
    const set = renderRail({ draft: { ...draft, assignee: "rpo" } });
    await openRow("Assignee");
    await pick(/Unassigned/);
    expect(set).toHaveBeenCalledWith("assignee", null);
  });

  it("edits the priority", async () => {
    const set = renderRail();
    await openRow("Priority");
    await pick(/Urgent/);
    expect(set).toHaveBeenCalledWith("priority", "urgent");
  });

  it("offers only the project's own categories", async () => {
    renderRail();
    await openRow("Type");
    expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual([
      "user-story",
      "bug",
    ]);
  });

  // Recurrence is not a custom field; it belongs with the rest of the details
  it("puts Repeats in the details and reads it back in words", () => {
    renderRail({ draft: { ...draft, recurrence: { frequency: "weekly", interval: 2 } } });
    expect(screen.getByText("Every 2 weeks")).toBeTruthy();
  });

  it("says Never when a task does not repeat", () => {
    renderRail();
    expect(screen.getByText("Never")).toBeTruthy();
  });

  it("keeps a completed sprint readable but not selectable", async () => {
    renderRail({ draft: { ...draft, sprint: "s2" } });
    expect(screen.getByText("Sprint 13")).toBeTruthy();
    await openRow("Sprint");
    const options = screen.getAllByRole("option").map((o) => o.textContent);
    expect(options.some((o) => o?.includes("Sprint 14"))).toBe(true);
    expect(options.some((o) => o?.includes("Sprint 13"))).toBe(false);
  });

  it("renders a group from the project's custom fields", async () => {
    const set = renderRail({ customFields: [field({})] });
    expect(screen.getByText("Custom fields")).toBeTruthy();
    await openRow("Team");
    await pick(/Platform/);
    expect(set).toHaveBeenCalledWith("customFieldValues", { f1: "o1" });
  });

  it("leaves the custom fields group out when the project defines none", () => {
    renderRail();
    expect(screen.queryByText("Custom fields")).toBeNull();
  });

  // Losing the marker along with the form would make a required field look optional
  it("marks a required custom field", () => {
    renderRail({ customFields: [field({ required: true })] });
    expect(screen.getByText("Team *")).toBeTruthy();
  });

  // CP-214 turned Difficulty into an ordinary project field, so it arrives through
  // the custom-fields group like any other
  it("renders a migrated field as a plain custom field", async () => {
    const set = renderRail({
      customFields: [
        field({
          _id: "f2",
          name: "Difficulty",
          options: [{ id: "XL", value: "XL", color: "#f87171", order: 0 }],
        }),
      ],
    });
    expect(screen.getByText("Custom fields")).toBeTruthy();
    await openRow("Difficulty");
    await pick(/^XL$/);
    expect(set).toHaveBeenCalledWith("customFieldValues", { f2: "XL" });
  });

  // The rail names the field on the left, so the control shows no label of its own —
  // which is exactly how a switch ends up with no accessible name at all
  it("gives a yes/no field a switch that still carries the field's name", async () => {
    const set = renderRail({
      customFields: [field({ _id: "f4", name: "Spike?", fieldType: "checkbox", options: [] })],
    });
    const toggle = screen.getByRole("switch", { name: "Spike?" }) as HTMLInputElement;
    expect(toggle.checked).toBe(false);
    await act(async () => toggle.click());
    expect(set).toHaveBeenCalledWith("customFieldValues", { f4: true });
  });

  it("rounds a number field's floating-point value for display", () => {
    renderRail({
      customFields: [field({ _id: "f3", name: "Estimate", fieldType: "number", options: [] })],
      draft: { ...draft, customFieldValues: { f3: 0.6000000000000001 } },
    });
    expect((screen.getByLabelText("Estimate") as HTMLInputElement).value).toBe("0.6");
  });

  // The rail used to be a display, so rounding there cost nothing. It is an editor now:
  // committing the rounded value would quietly drop the precision the task actually holds
  it("shows a number field's real value once it is being edited", async () => {
    renderRail({
      customFields: [field({ _id: "f3", name: "Estimate", fieldType: "number", options: [] })],
      draft: { ...draft, customFieldValues: { f3: 0.6000000000000001 } },
    });
    const input = screen.getByLabelText("Estimate") as HTMLInputElement;
    await act(async () => fireEvent.focus(input));
    expect(input.value).toBe("0.6000000000000001");
    await act(async () => fireEvent.blur(input));
    expect(input.value).toBe("0.6");
  });

  // A field with nothing to choose from is typed in the row; a popup would put a second
  // box on top of the one already showing the value
  it("edits a free-text field in the row rather than behind a picker", async () => {
    const set = renderRail({
      customFields: [field({ _id: "f5", name: "Notes", fieldType: "text", options: [] })],
    });
    const input = screen.getByLabelText("Notes") as HTMLInputElement;
    expect(input.placeholder).toBe("Empty");
    await act(async () =>
      fireEvent.change(input, { target: { value: "a note" } })
    );
    expect(set).toHaveBeenCalledWith("customFieldValues", { f5: "a note" });
  });

  it("stores a number field as a number, and clears it to empty rather than zero", async () => {
    const set = renderRail({
      customFields: [field({ _id: "f3", name: "Estimate", fieldType: "number", options: [] })],
      draft: { ...draft, customFieldValues: { f3: 3 } },
    });
    const input = screen.getByLabelText("Estimate") as HTMLInputElement;
    await act(async () => fireEvent.change(input, { target: { value: "8" } }));
    expect(set).toHaveBeenCalledWith("customFieldValues", { f3: 8 });
    await act(async () => fireEvent.change(input, { target: { value: "" } }));
    expect(set).toHaveBeenCalledWith("customFieldValues", { f3: "" });
  });

  it("announces a picker row as the listbox it opens", async () => {
    renderRail();
    const row = await openRow("Priority");
    expect(row.getAttribute("aria-haspopup")).toBe("listbox");
    expect(row.getAttribute("aria-expanded")).toBe("true");
  });

  it("announces a row that opens something other than a list as a dialog", async () => {
    renderRail();
    const row = await openRow("Repeats");
    expect(row.getAttribute("aria-haspopup")).toBe("dialog");
    expect(row.getAttribute("aria-expanded")).toBe("true");
  });

  // The tick is drawn, not typed: a "✓" in every row's text would be read out with
  // the label and would land in any assertion on an option's name
  it("keeps the selection tick out of the option's text", async () => {
    renderRail();
    await openRow("Priority");
    const options = screen.getAllByRole("option");
    expect(options.map((o) => o.textContent)).toEqual(["Low", "Medium", "High", "Urgent"]);
    expect(options.find((o) => o.textContent === "Medium")?.getAttribute("aria-selected")).toBe(
      "true"
    );
  });

  it("tints the type chip with the project's own colour for that category", () => {
    renderRail({ draft: { ...draft, category: "bug" } });
    const chip = screen.getByText("bug");
    expect(chip.getAttribute("style")).toContain("#ef4444");
  });

  it("names the reporter and keeps delete at the end", () => {
    const onDelete = vi.fn();
    renderRail({ onDelete });
    expect(screen.getByText(/Reported by Claude Code/)).toBeTruthy();
    screen.getByRole("button", { name: "Delete task" }).click();
    expect(onDelete).toHaveBeenCalled();
  });
});

/**
 * The agent decides what runs on the operator's machine, so the server refuses the write from
 * anyone below project admin. A picker that 403s on click would be the worse half of both — the
 * value stays readable, the control goes away.
 */
describe("the Agent row and who may change it", () => {
  const AGENTS = [
    { _id: "a1", name: "Default", scope: "global", description: "" },
    { _id: "a2", name: "With security review", scope: "global", description: "" },
  ] as never;

  // queryAllByRole, not getAllByRole: the latter throws on zero matches, which made this helper
  // depend on unrelated rows being present
  function agentRow() {
    return [...screen.queryAllByRole("combobox"), ...screen.queryAllByRole("button")].find((el) =>
      (el.textContent || "").startsWith("Agent")
    );
  }

  it("is a picker for an admin", () => {
    renderRail({ agents: AGENTS, draft: { ...draft, agent: "a2" } });

    expect(agentRow()?.getAttribute("role")).toBe("combobox");
    expect(agentRow()?.textContent).toContain("With security review");
  });

  it("shows the name but offers no control to anyone else", () => {
    isAdmin.value = false;
    renderRail({ agents: AGENTS, draft: { ...draft, agent: "a2" } });

    const row = screen.getByText("Agent").closest("div");
    expect(row?.textContent).toContain("With security review");
    expect(agentRow()).toBeUndefined();
  });

  // The first version of this asserted only the words "No agent", which ComboboxRow renders
  // too via emptyOption — so it passed with the admin picker on screen and could not fail. What
  // distinguishes the two is the control, not the label.
  it("says No agent to a non-admin, with no control to open", () => {
    isAdmin.value = false;
    renderRail({ agents: AGENTS });

    const row = screen.getByText("Agent").closest("div");
    expect(row?.textContent).toContain("No agent");
    expect(row?.querySelector("[role='combobox']")).toBeNull();
    expect(screen.queryAllByRole("combobox").some((el) => el.textContent?.startsWith("Agent"))).toBe(
      false
    );
  });

  // "Project default" was honest while an empty field fell back to the project's agent. Since BP-358
  // it means nobody takes the task, and the label has to say so — this is the only signal that a task
  // is one a person is doing.
  it("names the empty option for what it now means", async () => {
    renderRail({ agents: AGENTS });

    expect(screen.getByText("Agent").closest("div")?.textContent).toContain("No agent");
  });

  it("offers it as the first choice, so handing work to a machine stays deliberate", async () => {
    renderRail({ agents: AGENTS });
    await openRow("Agent");

    expect(screen.getAllByRole("option")[0].textContent).toContain("No agent");
  });

  // The project's default stops being what runs and becomes what is offered first. Without this the
  // setting has no job at all once the fallback is gone.
  it("offers the project's default ahead of the other agents", async () => {
    renderRail({ agents: AGENTS, projectDefaultAgent: "a2" });
    await openRow("Agent");

    const options = screen.getAllByRole("option").map((o) => o.textContent);
    expect(options[0]).toContain("No agent");
    expect(options[1]).toContain("With security review");
  });
});

/**
 * BP-358: the claim takes a task or it does not, and logs nothing either way. An agent chosen on a
 * task no machine will touch looks entirely normal on the card, which is why "why did nothing
 * happen" had no answer anywhere in the product.
 *
 * Every case is located by data-reason rather than by its wording: all four render the same
 * opening sentence, so a text matcher would pass with the wrong branch on screen.
 */
describe("the agent picker says when nothing will run the task", () => {
  const RAFAL = { _id: "u1", username: "rpo", fullName: "Rafal Podles" } as ApiUser;
  const AGENT = [{ _id: "a1", name: "Default" }] as React.ComponentProps<
    typeof PropertyRail
  >["agents"];

  function withStored(stored: Partial<ApiTask>, over: Partial<TaskDraft> = {}) {
    renderRail({
      agents: AGENT,
      draft: { ...draft, agent: "a1", assignee: "rpo", ...over },
      stored: { agent: "a1", assignee: RAFAL, assignedBy: { ...RAFAL }, ...stored } as ApiTask,
    });
  }

  it("says nothing when the assignee handed it to themselves", () => {
    withStored({});

    expect(screen.queryByTestId("handover-notice")).toBeNull();
  });

  it("says nothing about a task with no agent, which is the ordinary case", () => {
    withStored({ agent: null, assignee: null }, { agent: null, assignee: null });

    expect(screen.queryByTestId("handover-notice")).toBeNull();
  });

  it("says an unassigned task belongs to nobody", () => {
    withStored({ assignee: null }, { assignee: null });

    expect(screen.getByTestId("handover-notice").dataset.reason).toBe("unassigned");
  });

  // The legacy case, and the visible half of refusing to backfill assignedBy
  it("says a task assigned before the board recorded who assigns will not run", () => {
    withStored({ assignedBy: undefined });

    const notice = screen.getByTestId("handover-notice");
    expect(notice.dataset.reason).toBe("assigner-unrecorded");
    expect(notice.textContent).toMatch(/assign it again/i);
  });

  it("names whoever else handed it over", () => {
    withStored({ assignedBy: { _id: "u2", username: "kmk", fullName: "Krzysiek" } });

    const notice = screen.getByTestId("handover-notice");
    expect(notice.dataset.reason).toBe("assigned-by-someone-else");
    expect(notice.textContent).toContain("Krzysiek");
  });

  // The verdict depends on assignedBy, which only the server writes. Judging an unsaved draft
  // would tell somebody who just picked an assignee that their own task will not run.
  it("says nothing while the draft has an edit the server has not seen", () => {
    withStored({ assignee: null }, { assignee: "rpo" });

    expect(screen.queryByTestId("handover-notice")).toBeNull();
  });

  // Clearing the agent is the fix for every one of these notices, so the notice has to go the
  // moment it is cleared rather than sitting there until the save lands. The stored task would
  // otherwise render "assigned before the board recorded who assigns".
  it("says nothing while the agent itself is the unsaved edit", () => {
    withStored({ assignedBy: undefined }, { agent: null });

    expect(screen.queryByTestId("handover-notice")).toBeNull();
  });

  // Readable by everyone: a member who cannot choose the agent is exactly the person who needs to
  // be told the task is waiting on them
  it("is shown to somebody who cannot change the agent", () => {
    isAdmin.value = false;
    withStored({ assignedBy: undefined });

    expect(screen.getByTestId("handover-notice").dataset.reason).toBe("assigner-unrecorded");
  });
});
