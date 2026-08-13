// @vitest-environment happy-dom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, act } from "@testing-library/react";
import { PropertyRail } from "./PropertyRail";
import type { TaskDraft } from "./useTaskEditor";
import { ApiCustomField, ApiSprint, ApiUser } from "@/types";

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
      taskKey="TP-1"
      users={users}
      sprints={sprints}
      categories={["user-story", "bug"]}
      customFields={[]}
      reporter="Claude Code"
      onDelete={() => {}}
      {...over}
    />
  );
  return set;
}

async function openRow(label: string | RegExp) {
  const row = screen
    .getAllByRole("button")
    .find((b) => (typeof label === "string" ? b.textContent?.startsWith(label) : label.test(b.textContent || "")));
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

  it("announces a row as something that opens a popup", async () => {
    renderRail();
    const row = await openRow("Priority");
    expect(row.getAttribute("aria-haspopup")).toBe("dialog");
    expect(row.getAttribute("aria-expanded")).toBe("true");
  });

  it("names the reporter and keeps delete at the end", () => {
    const onDelete = vi.fn();
    renderRail({ onDelete });
    expect(screen.getByText(/Reported by Claude Code/)).toBeTruthy();
    screen.getByRole("button", { name: "Delete task" }).click();
    expect(onDelete).toHaveBeenCalled();
  });
});
