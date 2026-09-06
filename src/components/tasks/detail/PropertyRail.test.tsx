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

const PROJECT_ID = "p-this-board";

function renderRail(over: Partial<React.ComponentProps<typeof PropertyRail>> = {}) {
  const set = vi.fn();
  render(
    <PropertyRail
      draft={draft}
      set={set}
      users={users}
      sprints={sprints}
      agents={[]}
      projectId={PROJECT_ID}
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

  it("names an assignee the roster does not contain, rather than reading as unassigned", () => {
    renderRail({
      users: [],
      draft: { ...draft, assignee: "kasia" },
      stored: {
        agent: null,
        assignee: { _id: "u9", username: "kasia", fullName: "Kasia Nowak" },
        assignedBy: null,
        status: "todo",
      } as React.ComponentProps<typeof PropertyRail>["stored"],
    });

    const row = screen
      .getAllByRole("combobox")
      .find((b) => b.textContent?.startsWith("Assignee"))!;
    expect(row.textContent).toContain("Kasia Nowak");
    expect(row.textContent).not.toContain("Unassigned");
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

  it("puts Repeats in the details and reads it back in words", () => {
    renderRail({
      draft: { ...draft, recurrence: { frequency: "weekly", interval: 2, endDate: null } },
    });
    expect(screen.getByText("Every 2 weeks")).toBeTruthy();
  });

  it("reads back the day a series stops", () => {
    renderRail({
      draft: { ...draft, recurrence: { frequency: "weekly", interval: 1, endDate: "2026-12-31" } },
    });
    expect(screen.getByText(/Every week until/)).toBeTruthy();
  });

  it("gives a repeating task an end", async () => {
    const recurrence = { frequency: "weekly" as const, interval: 1, endDate: null };
    const set = renderRail({ draft: { ...draft, recurrence } });
    await openRow("Repeats");

    fireEvent.change(screen.getByLabelText("Repeats until"), { target: { value: "2026-12-31" } });
    expect(set).toHaveBeenCalledWith("recurrence", { ...recurrence, endDate: "2026-12-31" });
  });

  it("clears an end back to a series with no end", async () => {
    const recurrence = { frequency: "weekly" as const, interval: 1, endDate: "2026-12-31" };
    const set = renderRail({ draft: { ...draft, recurrence } });
    await openRow("Repeats");

    fireEvent.change(screen.getByLabelText("Repeats until"), { target: { value: "" } });
    expect(set).toHaveBeenCalledWith("recurrence", { ...recurrence, endDate: null });
  });

  it("clamps a pasted interval to the maximum it advertises", async () => {
    const recurrence = { frequency: "weekly" as const, interval: 1, endDate: null };
    const set = renderRail({ draft: { ...draft, recurrence } });
    await openRow("Repeats");

    const every = screen.getByRole("spinbutton");
    fireEvent.change(every, { target: { value: "400" } });

    expect(set).toHaveBeenCalledWith("recurrence", { ...recurrence, interval: 365 });
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

  it("marks a required custom field", () => {
    renderRail({ customFields: [field({ required: true })] });
    expect(screen.getByText("Team *")).toBeTruthy();
  });

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

describe("the Agent row", () => {
  const AGENTS = [
    { _id: "a1", name: "Default", scope: "global", description: "" },
    { _id: "a2", name: "With security review", scope: "global", description: "" },
  ] as never;

  function agentRow() {
    return [...screen.queryAllByRole("combobox"), ...screen.queryAllByRole("button")].find((el) =>
      (el.textContent || "").startsWith("Agent")
    );
  }

  it("is a picker, and shows the chosen agent in it", () => {
    renderRail({ agents: AGENTS, draft: { ...draft, agent: "a2" } });

    expect(agentRow()?.getAttribute("role")).toBe("combobox");
    expect(agentRow()?.textContent).toContain("With security review");
  });

  it("offers the picker with nothing chosen either, and no note about who may", () => {
    renderRail({ agents: AGENTS });

    expect(agentRow()?.getAttribute("role")).toBe("combobox");
    expect(screen.queryByTestId("agent-not-yours")).toBeNull();
    expect(screen.getByText("Agent").closest("div")?.textContent).not.toMatch(/instance admin/i);
  });

  it("names the empty option for what it now means", async () => {
    renderRail({ agents: AGENTS });

    expect(screen.getByText("Agent").closest("div")?.textContent).toContain("No agent");
  });

  it("offers it as the first choice, so handing work to a machine stays deliberate", async () => {
    renderRail({ agents: AGENTS });
    await openRow("Agent");

    expect(screen.getAllByRole("option")[0].textContent).toContain("No agent");
  });

  it("offers the project's default ahead of the other agents", async () => {
    renderRail({ agents: AGENTS, projectDefaultAgent: "a2" });
    await openRow("Agent");

    const options = screen.getAllByRole("option").map((o) => o.textContent);
    expect(options[0]).toContain("No agent");
    expect(options[1]).toContain("With security review");
  });

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

  describe("and a project agent, which belongs to one board", () => {
    const OURS = { _id: "a4", name: "Our board's agent", scope: "project", projectId: PROJECT_ID };
    const THEIRS = { _id: "a5", name: "Other board's agent", scope: "project", projectId: "p-elsewhere" };
    const BOTH = [
      ...(AGENTS as unknown as Record<string, unknown>[]),
      OURS,
      THEIRS,
    ] as never;

    async function agentOptions() {
      await openRow("Agent");
      return screen.getAllByRole("option").map((o) => o.textContent || "");
    }

    it("offers this board's own, and withholds the other board's", async () => {
      renderRail({ agents: BOTH });

      const options = (await agentOptions()).join("|");
      expect(options).toContain("Our board's agent");
      expect(options).not.toContain("Other board's agent");
    });

    it("still names the other board's agent when the task is already carrying it", async () => {
      renderRail({ agents: BOTH, draft: { ...draft, agent: "a5" } });

      expect((await agentOptions()).join("|")).toContain("Other board's agent");
    });

    it("does not blame the missing row on the reader's own agents", async () => {
      renderRail({ agents: BOTH });
      await openRow("Agent");

      expect(screen.queryByTestId("personal-agents-withheld")).toBeNull();
    });

    it("still says it when a personal agent is withheld beside the other board's", async () => {
      const ALSO_SOMEBODY_ELSES = [
        ...(BOTH as unknown as Record<string, unknown>[]),
        { _id: "a6", name: "Their own agent", scope: "user", description: "" },
      ] as never;
      renderRail({ agents: ALSO_SOMEBODY_ELSES, currentUsername: "rpo" });
      await openRow("Agent");

      expect(screen.queryByTestId("personal-agents-withheld")).not.toBeNull();
      const options = screen.getAllByRole("option").map((o) => o.textContent || "").join("|");
      expect(options).toContain("Our board's agent");
      expect(options).not.toContain("Their own agent");
      expect(options).not.toContain("Other board's agent");
    });
  });

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

    it("withholds it on a task assigned to somebody else", async () => {
      renderRail({ agents: MINE, draft: { ...draft, assignee: "claude" }, currentUsername: "rpo" });

      expect((await agentOptions()).join("|")).not.toContain("My own agent");
    });

    it("says why it is not there, rather than shortening the list in silence", async () => {
      renderRail({ agents: MINE, draft: { ...draft, assignee: "claude" }, currentUsername: "rpo" });

      expect(screen.getByTestId("personal-agents-withheld").textContent).toMatch(
        /personal agent only runs on a task you have assigned to yourself/i
      );
    });

    it("withholds it on an unassigned task", async () => {
      renderRail({ agents: MINE, currentUsername: "rpo" });

      expect((await agentOptions()).join("|")).not.toContain("My own agent");
      expect(screen.queryByTestId("personal-agents-withheld")).not.toBeNull();
    });

    it("offers it as soon as the draft assigns the task to me, before anything is saved", async () => {
      renderRail({
        agents: MINE,
        draft: { ...draft, assignee: "rpo" },
        stored: { agent: null, assignee: null, assignedBy: null, status: "todo" },
        currentUsername: "rpo",
      });

      expect((await agentOptions()).join("|")).toContain("My own agent");
    });

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

    it("says nothing when there is no personal agent to withhold", () => {
      renderRail({ agents: AGENTS, draft: { ...draft, assignee: "claude" }, currentUsername: "rpo" });

      expect(screen.queryByTestId("personal-agents-withheld")).toBeNull();
    });

    it("withholds it on an unassigned task when there is no reader either", async () => {
      renderRail({ agents: MINE, currentUsername: null });

      expect((await agentOptions()).join("|")).not.toContain("My own agent");
    });

    it("withholds it from a reader the app cannot name, on somebody's task", async () => {
      renderRail({ agents: MINE, draft: { ...draft, assignee: "rpo" }, currentUsername: null });

      expect((await agentOptions()).join("|")).not.toContain("My own agent");
    });
  });

  describe("and an agent the reader may not choose, which the task carries anyway", () => {
    const CARRIED = {
      agent: { _id: "a9", name: "Kasia's own agent" },
      assignee: { _id: "u2", username: "claude", fullName: "Claude Code" },
      assignedBy: { _id: "u2", username: "claude", fullName: "Claude Code" },
      status: "ready",
    } as unknown as ApiTask;

    const MINE_AND_THEIRS = [
      ...(AGENTS as unknown as { _id: string; name: string; scope: string }[]),
      { _id: "a3", name: "My own agent", scope: "user", description: "" },
    ] as never;

    function renderCarried(over: Partial<React.ComponentProps<typeof PropertyRail>> = {}) {
      return renderRail({
        agents: AGENTS,
        draft: { ...draft, assignee: "claude", agent: "a9" },
        stored: CARRIED,
        currentUsername: "rpo",
        columns: BOARD,
        ...over,
      });
    }

    it("names it, instead of saying the task has none", () => {
      renderCarried();

      expect(screen.getByTestId("agent-not-offered").textContent).toBe("Kasia's own agent");
    });

    it("offers no picker for it, because re-choosing it is what the server refuses", () => {
      renderCarried();

      expect(
        [...screen.queryAllByRole("combobox")].find((el) =>
          (el.textContent || "").startsWith("Agent")
        )
      ).toBeUndefined();
    });

    it("says why it is not yours to choose", () => {
      renderCarried();

      expect(screen.getByTestId("agent-not-offered-reason").textContent).toMatch(
        /only offered to the person who composed it/i
      );
    });

    it("does not also explain a shortened list where there is no list", () => {
      renderCarried({ agents: MINE_AND_THEIRS });

      expect(screen.queryByTestId("personal-agents-withheld")).toBeNull();
    });

    it("leaves the row a picker when the agent is one the reader can see", () => {
      renderRail({
        agents: AGENTS,
        draft: { ...draft, agent: "a2" },
        stored: { agent: "a2", assignee: null, assignedBy: null, status: "todo" },
      });

      expect(screen.queryByTestId("agent-not-offered")).toBeNull();
      expect(
        [...screen.queryAllByRole("combobox")].find((el) =>
          (el.textContent || "").startsWith("Agent")
        )?.textContent
      ).toContain("With security review");
    });

    it("still judges the hand-over, though the stored agent arrives populated", () => {
      renderRail({
        agents: AGENTS,
        draft: { ...draft, assignee: "claude", agent: "a2" },
        stored: {
          agent: { _id: "a2", name: "With security review" },
          assignee: { _id: "u2", username: "claude", fullName: "Claude Code" },
          assignedBy: { _id: "u1", username: "rpo", fullName: "Rafal Podles" },
          status: "ready",
        } as unknown as ApiTask,
        columns: BOARD,
      });

      expect(screen.getByTestId("handover-notice").getAttribute("data-reason")).toBe(
        "assigned-by-someone-else"
      );
    });
  });
});

describe("the agent picker says when nothing will run the task", () => {
  const RAFAL = { _id: "u1", username: "rpo", fullName: "Rafal Podles" } as ApiUser;
  const AGENT = [{ _id: "a1", name: "Default" }] as React.ComponentProps<
    typeof PropertyRail
  >["agents"];

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

  it("says a task before the approved column is not there yet", () => {
    withStored({ status: "someday" });

    const notice = screen.getByTestId("handover-notice");
    expect(notice.dataset.reason).toBe("not-approved-yet");
    expect(notice.textContent).toMatch(/column work is approved in/i);
  });

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

  it("says a task assigned before the board recorded who assigns will not run", () => {
    withStored({ assignedBy: undefined });

    const notice = screen.getByTestId("handover-notice");
    expect(notice.dataset.reason).toBe("assigner-unrecorded");
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

  it("falls back to Somebody else when the assigner came back unpopulated", () => {
    withStored({ assignedBy: "u2" });

    const notice = screen.getByTestId("handover-notice");
    expect(notice.dataset.reason).toBe("assigned-by-someone-else");
    expect(notice.textContent).toMatch(/Somebody else assigned it/i);
  });

  it("says nothing while the draft has an edit the server has not seen", () => {
    withStored({ assignee: null }, { assignee: "rpo" });

    expect(screen.queryByTestId("handover-notice")).toBeNull();
  });

  it("says nothing while the agent itself is the unsaved edit", () => {
    withStored({ assignedBy: undefined }, { agent: null });

    expect(screen.queryByTestId("handover-notice")).toBeNull();
  });

});

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

  it("leaves a task whose assigner is recorded alone", async () => {
    const repair = railFor({});
    await openRow("Assignee");
    await pick(/Rafal Podles/);

    expect(repair).not.toHaveBeenCalled();
  });

  it("leaves a genuine change to the ordinary save", async () => {
    const repair = railFor({ assignedBy: undefined });
    await openRow("Assignee");
    await pick(/Claude Code/);

    expect(repair).not.toHaveBeenCalled();
  });

  it("does not mistake unassigning for re-picking the same person", async () => {
    const repair = railFor({ assignedBy: undefined });
    await openRow("Assignee");
    await pick(/Unassigned/);

    expect(repair).not.toHaveBeenCalled();
  });
});
