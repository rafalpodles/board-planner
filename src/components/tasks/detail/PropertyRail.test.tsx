// @vitest-environment happy-dom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, act, fireEvent } from "@testing-library/react";
import { PropertyRail } from "./PropertyRail";
import type { TaskDraft } from "./useTaskEditor";
import { ApiCustomField, ApiSprint, ApiTask, ApiUser } from "@/types";
import type { AnyColumn } from "@/lib/columns";

afterEach(cleanup);

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

// Not the seeded seven: with those the approved column is literally called "todo" and the active
// one "in_progress", so an implementation comparing ids rather than roles would pass every case
const BOARD: AnyColumn[] = [
  { id: "someday", label: "Someday", color: "#888", role: "backlog", order: 0 },
  { id: "ready", label: "Ready", color: "#888", role: "approved", order: 1 },
  { id: "doing", label: "Doing", color: "#888", role: "active", order: 2 },
  { id: "shipped", label: "Shipped", color: "#888", role: "done", order: 3 },
];

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
      stored={{ agent: null, assignee: null, assignedBy: null, status: "todo" }}
      onRepairAssigner={() => {}}
      currentUsername="rpo"
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
 * The agent decides what runs on the operator's machine. BP-345 made this row read-only for anyone
 * below instance admin, because choosing an agent could then arm somebody else's machine; BP-358
 * moved that boundary into the claim — assignee === assignedBy === the machine's owner — and the
 * row went back to being an ordinary editable field for whoever may edit the task.
 */
describe("the Agent row", () => {
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

  /**
   * A control, not a label. The version of this that asserted only the words "No agent" passed with
   * the read-only row on screen, because that row rendered the same words — what distinguishes the
   * two is whether there is anything to open.
   */
  it("is a picker, and shows the chosen agent in it", () => {
    renderRail({ agents: AGENTS, draft: { ...draft, agent: "a2" } });

    expect(agentRow()?.getAttribute("role")).toBe("combobox");
    expect(agentRow()?.textContent).toContain("With security review");
  });

  // The read-only branch had its own empty state, telling the reader that handing work to a machine
  // was not theirs to do. There is no such reader left, and leaving that sentence in the product
  // would be refusing somebody a thing they can now simply do.
  it("offers the picker with nothing chosen either, and no note about who may", () => {
    renderRail({ agents: AGENTS });

    expect(agentRow()?.getAttribute("role")).toBe("combobox");
    expect(screen.queryByTestId("agent-not-yours")).toBeNull();
    expect(screen.getByText("Agent").closest("div")?.textContent).not.toMatch(/instance admin/i);
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

  // Nothing checked what picking the empty option actually sends. It is inert today only because
  // updateTask normalises "" to null before the write, which is pinned in task-service.test.ts —
  // this is the other half. If the picker ever sent "" straight through to a caller that does not
  // normalise, it would reach an ObjectId ref as an empty string.
  it("sends null when the empty option is picked, never an empty string", async () => {
    const set = renderRail({ agents: AGENTS, draft: { ...draft, agent: "a2" } });
    await openRow("Agent");
    await pick(/No agent/);

    expect(set).toHaveBeenCalledWith("agent", null);
  });

  it("sends the id when a real agent is picked", async () => {
    const set = renderRail({ agents: AGENTS });
    await openRow("Agent");
    await pick(/With security review/);

    expect(set).toHaveBeenCalledWith("agent", "a2");
  });

  /**
   * `agentUsableOnProject` runs a personal agent only on a task its owner assigned to themselves —
   * anyone may compose one, so its steps are a composition nobody vetted, and a `merge` step merges
   * whatever the prompt around it says. Offering one anywhere else would be a control that 400s on
   * click, and this view's save failure prints no server message at all: "Save failed — retry",
   * and retrying fails the same way.
   *
   * `/api/agents` only ever answers with the reader's OWN user-scoped agents, so `scope: "user"`
   * in this list always means mine.
   */
  describe("and a personal agent, which the server runs only on its owner's own task", () => {
    const MINE = [
      ...(AGENTS as unknown as { _id: string; name: string; scope: string }[]),
      { _id: "a3", name: "My own agent", scope: "user", description: "" },
    ] as never;

    async function agentOptions() {
      await openRow("Agent");
      return screen.getAllByRole("option").map((o) => o.textContent || "");
    }

    it("offers it on a task assigned to me", async () => {
      renderRail({ agents: MINE, draft: { ...draft, assignee: "rpo" }, currentUsername: "rpo" });

      expect((await agentOptions()).join("|")).toContain("My own agent");
      expect(screen.queryByTestId("personal-agents-withheld")).toBeNull();
    });

    // The shape the server refuses. Asserted on the option list rather than on the note, so a
    // version that printed the sentence and still offered the control would fail.
    it("withholds it on a task assigned to somebody else", async () => {
      renderRail({ agents: MINE, draft: { ...draft, assignee: "claude" }, currentUsername: "rpo" });

      expect((await agentOptions()).join("|")).not.toContain("My own agent");
    });

    // …and the other half: withholding it without saying so is the silent refusal, just moved
    it("says why it is not there, rather than shortening the list in silence", async () => {
      renderRail({ agents: MINE, draft: { ...draft, assignee: "claude" }, currentUsername: "rpo" });

      expect(screen.getByTestId("personal-agents-withheld").textContent).toMatch(
        /personal agent only runs on a task you have assigned to yourself/i
      );
    });

    // Nobody's task is not my task, and it is also what a released task looks like
    it("withholds it on an unassigned task", async () => {
      renderRail({ agents: MINE, currentUsername: "rpo" });

      expect((await agentOptions()).join("|")).not.toContain("My own agent");
      expect(screen.queryByTestId("personal-agents-withheld")).not.toBeNull();
    });

    /**
     * The draft, not the stored task: auto-save sends every edited field in one PUT, and the server
     * judges the assignee that write LEAVES. Keyed on the stored value, taking a task on and
     * picking your own agent in the same visit would offer nothing until the page reloaded.
     */
    it("offers it as soon as the draft assigns the task to me, before anything is saved", async () => {
      renderRail({
        agents: MINE,
        draft: { ...draft, assignee: "rpo" },
        stored: { agent: null, assignee: null, assignedBy: null, status: "todo" },
        currentUsername: "rpo",
      });

      expect((await agentOptions()).join("|")).toContain("My own agent");
    });

    /**
     * Filtering the list must not filter what the task is carrying. A personal agent can outlive
     * the pairing — reassigning a task does not re-check its agent — and a row rendering "No agent"
     * over a task that has one is the diagnostic this branch spent two rounds removing.
     */
    it("still names the agent already on the task, even when it would not be offered", async () => {
      renderRail({
        agents: MINE,
        draft: { ...draft, assignee: "claude", agent: "a3" },
        currentUsername: "rpo",
      });

      expect(
        [...screen.queryAllByRole("combobox")]
          .find((el) => (el.textContent || "").startsWith("Agent"))
          ?.textContent
      ).toContain("My own agent");
    });

    // Nothing to withhold, nothing to explain: the note must not appear on a board whose agents are
    // all the project's or the instance's
    it("says nothing when there is no personal agent to withhold", () => {
      renderRail({ agents: AGENTS, draft: { ...draft, assignee: "claude" }, currentUsername: "rpo" });

      expect(screen.queryByTestId("personal-agents-withheld")).toBeNull();
    });

    /**
     * On an UNASSIGNED task specifically, which is where the two nulls meet: `draft.assignee` is
     * null for "nobody has it" and `currentUsername` is null for "the app has not resolved a
     * reader yet", and comparing them alone makes those the same answer. A version keyed on
     * "assigned to me" without asking whether there is a me offers the whole personal shelf on
     * every unassigned task to a reader it cannot name.
     */
    it("withholds it on an unassigned task when there is no reader either", async () => {
      renderRail({ agents: MINE, currentUsername: null });

      expect((await agentOptions()).join("|")).not.toContain("My own agent");
    });

    // The same guard from the other side: a reader who is not the assignee is not the assignee
    it("withholds it from a reader the app cannot name, on somebody's task", async () => {
      renderRail({ agents: MINE, draft: { ...draft, assignee: "rpo" }, currentUsername: null });

      expect((await agentOptions()).join("|")).not.toContain("My own agent");
    });
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

  // `status` widened to a plain string: TaskStatus is the union of the SEEDED column ids, and this
  // board deliberately uses none of them
  function withStored(
    stored: Partial<Omit<ApiTask, "status">> & { status?: string },
    over: Partial<TaskDraft> = {}
  ) {
    renderRail({
      agents: AGENT,
      columns: BOARD,
      draft: { ...draft, agent: "a1", assignee: "rpo", ...over },
      stored: {
        agent: "a1",
        assignee: RAFAL,
        assignedBy: { ...RAFAL },
        status: "ready",
        ...stored,
      } as ApiTask,
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

  // A task with an agent, self-assigned, and simply not in the column a claim looks at
  it("says a task before the approved column is not there yet", () => {
    withStored({ status: "someday" });

    const notice = screen.getByTestId("handover-notice");
    expect(notice.dataset.reason).toBe("not-approved-yet");
    // The wording too, not only the attribute: every branch renders the same opening sentence, so
    // the attribute says WHICH branch and the text says whether it tells the truth. Without this
    // the message could be replaced with the opposite of what it means and stay green.
    expect(notice.textContent).toMatch(/column work is approved in/i);
  });

  /**
   * The reproduction: a task with an agent, self-assigned, sitting in the active column with a run
   * on it, rendered "Nothing will run this yet — move it to the column work is approved in" beside
   * the live run indicator. `done` said the same. The requirement belongs before the approved
   * column, and the notice was reading a list of approved ids rather than the board's roles.
   */
  it.each(["doing", "shipped"])(
    "says nothing about a task in %s, which a machine is past being asked about",
    (status) => {
      withStored({ status });

      expect(screen.queryByTestId("handover-notice")).toBeNull();
    }
  );

  it("says an unassigned task belongs to nobody", () => {
    withStored({ assignee: null }, { assignee: null });

    const notice = screen.getByTestId("handover-notice");
    expect(notice.dataset.reason).toBe("unassigned");
    expect(notice.textContent).toMatch(/Nothing will run this/i);
    expect(notice.textContent).toMatch(/assign it to yourself/i);
  });

  // The legacy case, and the visible half of refusing to backfill assignedBy
  it("says a task assigned before the board recorded who assigns will not run", () => {
    withStored({ assignedBy: undefined });

    const notice = screen.getByTestId("handover-notice");
    expect(notice.dataset.reason).toBe("assigner-unrecorded");
    // Who can perform it, not only that a repair exists: the server records the assigner only for
    // the person being assigned, so a sentence addressed to whoever is reading would be wrong for
    // everybody else on the board
    expect(notice.textContent).toMatch(/its assignee can record that by assigning it to themselves/i);
  });

  it("names whoever else handed it over", () => {
    withStored({ assignedBy: { _id: "u2", username: "kmk", fullName: "Krzysiek" } });

    const notice = screen.getByTestId("handover-notice");
    expect(notice.dataset.reason).toBe("assigned-by-someone-else");
    expect(notice.textContent).toMatch(
      /Krzysiek assigned it, and a machine takes only work its owner assigned to themselves/i
    );
  });

  // The fallback nothing asserted: an assignedBy the server answered as a bare id has no name to
  // render, and the sentence still has to read as one
  it("falls back to Somebody else when the assigner came back unpopulated", () => {
    withStored({ assignedBy: "u2" });

    const notice = screen.getByTestId("handover-notice");
    expect(notice.dataset.reason).toBe("assigned-by-someone-else");
    expect(notice.textContent).toMatch(/Somebody else assigned it/i);
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

});

/**
 * The Agent row tells the reader to "assign it again to record that", and the detail view saves by
 * diff — so re-picking the person already on the task produced no request at all, and the recovery
 * the product printed was a no-op in the view printing it. The e2e that proves the repair calls
 * updateTask directly, stepping straight over this seam.
 *
 * What the forced write reaches is asserted in TaskDetail.test.tsx: this half only says when the
 * rail asks for one.
 */
describe("re-assigning to record an assigner the board never had", () => {
  const RAFAL = { _id: "u1", username: "rpo", fullName: "Rafal Podles" } as ApiUser;

  function railFor(stored: Partial<Omit<ApiTask, "status">> & { status?: string }) {
    const onRepairAssigner = vi.fn();
    renderRail({
      agents: [{ _id: "a1", name: "Default" }] as React.ComponentProps<typeof PropertyRail>["agents"],
      columns: BOARD,
      draft: { ...draft, agent: "a1", assignee: "rpo" },
      stored: { agent: "a1", assignee: RAFAL, assignedBy: { ...RAFAL }, status: "ready", ...stored } as ApiTask,
      onRepairAssigner,
    });
    return onRepairAssigner;
  }

  it("forces the write when the assignee already on the task is picked again", async () => {
    const repair = railFor({ assignedBy: undefined });
    await openRow("Assignee");
    await pick(/Rafal Podles/);

    expect(repair).toHaveBeenCalledWith("rpo");
  });

  // Nothing to record, so nothing to force: the ordinary diff already declines to write this, and
  // forcing it would put a save on the wire every time somebody opened the picker and changed
  // their mind
  it("leaves a task whose assigner is recorded alone", async () => {
    const repair = railFor({});
    await openRow("Assignee");
    await pick(/Rafal Podles/);

    expect(repair).not.toHaveBeenCalled();
  });

  // Picking somebody else is an ordinary edit: it differs from the stored value, so auto-save
  // sends it, and stamping the assigner is then the server's ordinary behaviour
  it("leaves a genuine change to the ordinary save", async () => {
    const repair = railFor({ assignedBy: undefined });
    await openRow("Assignee");
    await pick(/Claude Code/);

    expect(repair).not.toHaveBeenCalled();
  });

  // Unassigning is a change too, and it is the one case where the picked value is null on both
  // sides if the guard compared the wrong things
  it("does not mistake unassigning for re-picking the same person", async () => {
    const repair = railFor({ assignedBy: undefined });
    await openRow("Assignee");
    await pick(/Unassigned/);

    expect(repair).not.toHaveBeenCalled();
  });
});
