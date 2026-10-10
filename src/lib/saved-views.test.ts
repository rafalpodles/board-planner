import { describe, it, expect } from "vitest";
import { ApiCustomField, ApiProjectCategory, ISavedView } from "@/types";
import { mayEditView, mayReadView, parseViewState, toApiView, viewNameOrRefusal } from "./saved-views";
import { ME } from "./board-filters-state";

const dropdown = {
  _id: "f-size",
  name: "Size",
  fieldType: "dropdown",
  filterable: true,
  archived: false,
  options: [{ id: "s", value: "S", order: 0 }],
} as unknown as ApiCustomField;
const categories = [{ _id: "c1", name: "bug", color: "#111" }] as ApiProjectCategory[];
const board = { customFields: [dropdown], categories };

const stateOf = (body: Record<string, unknown>) => {
  const parsed = parseViewState(body, board);
  if ("error" in parsed) throw new Error(parsed.error);
  return parsed.state;
};
const errorOf = (body: Record<string, unknown>) => {
  const parsed = parseViewState(body, board);
  return "error" in parsed ? parsed.error : null;
};

describe("viewNameOrRefusal", () => {
  it("trims, and refuses blank, over-long and control-character names", () => {
    expect(viewNameOrRefusal("  My work ")).toEqual({ name: "My work" });
    expect(viewNameOrRefusal("   ")).toHaveProperty("error");
    expect(viewNameOrRefusal(5)).toHaveProperty("error");
    expect(viewNameOrRefusal("x".repeat(101))).toHaveProperty("error");
    expect(viewNameOrRefusal("a\u0007b")).toHaveProperty("error");
  });
});

describe("parseViewState", () => {
  it("defaults an empty body to the plain board", () => {
    expect(stateOf({})).toMatchObject({
      search: "",
      sortField: "manual",
      sortDir: "asc",
      viewMode: "board",
      groupBy: "",
      sprintScope: "all",
    });
  });

  it("keeps the assignee sentinel for the reader, and every built-in filter it was given", () => {
    const { filters } = stateOf({ filters: { assignee: ME, priority: "high", status: "active" } });
    expect(filters).toMatchObject({ assignee: ME, priority: "high", status: "active" });
  });

  it("drops a filter on a field the project does not have, or on a category it lost", () => {
    const { filters } = stateOf({
      filters: { category: "gone", fields: { "f-size": { value: "s" }, ghost: { value: "x" } } },
    });
    expect(filters).toMatchObject({ category: "", fields: { "f-size": { value: "s" } } });
  });

  it("drops a grouping and hidden columns that name a field that does not exist", () => {
    const state = stateOf({ groupBy: "field:ghost", hiddenColumns: ["ghost", "sprint"] });
    expect(state.groupBy).toBe("");
    expect(state.hiddenColumns).toEqual(["sprint"]);
  });

  it("keeps a real grouping, sort, mode, scope and search", () => {
    expect(
      stateOf({
        groupBy: "priority",
        sortField: "dueDate",
        sortDir: "desc",
        viewMode: "list",
        sprintScope: "backlog",
        search: "login",
      })
    ).toMatchObject({
      groupBy: "priority",
      sortField: "dueDate",
      sortDir: "desc",
      viewMode: "list",
      sprintScope: "backlog",
      search: "login",
    });
  });

  it("rebuilds every field filter from its known keys, so nothing odd reaches the stored document", () => {
    const { filters } = stateOf({
      filters: {
        fields: {
          "f-size": { value: "s", $gt: 5, "a.b": 1, from: { nested: true }, to: ["x"] },
          ghost: { value: "x" },
        },
      },
    });
    expect(filters.fields).toEqual({ "f-size": { value: "s" } });
  });

  it("keeps a sort the board knows or a live field's, and falls back to manual for anything else", () => {
    expect(stateOf({ sortField: "dueDate" }).sortField).toBe("dueDate");
    expect(stateOf({ sortField: "f-size" }).sortField).toBe("f-size");
    expect(stateOf({ sortField: "constructor" }).sortField).toBe("manual");
    expect(stateOf({ sortField: "f-gone" }).sortField).toBe("manual");
  });

  it("refuses each shape it cannot store", () => {
    expect(errorOf({ filters: [] })).toMatch(/filters/);
    expect(errorOf({ filters: { assignee: 5 } })).toMatch(/assignee/);
    expect(errorOf({ filters: { assignee: "x".repeat(201) } })).toMatch(/assignee/);
    expect(errorOf({ filters: { fields: { a: { value: "x".repeat(25_000) } } } })).toMatch(/too large/);
    expect(errorOf({ search: "x".repeat(201) })).toMatch(/search/);
    expect(errorOf({ sortField: "" })).toMatch(/sortField/);
    expect(errorOf({ sortDir: "sideways" })).toMatch(/sortDir/);
    expect(errorOf({ viewMode: "gantt" })).toMatch(/viewMode/);
    expect(errorOf({ sprintScope: "not a scope!" })).toMatch(/sprintScope/);
    expect(errorOf({ hiddenColumns: "status" })).toMatch(/hiddenColumns/);
  });
});

describe("who may read and change a view", () => {
  const view = (owner: string, shared: boolean) => ({ owner: { toString: () => owner }, shared });

  it("shows a personal view to its owner only, and a shared one to everybody", () => {
    expect(mayReadView(view("u1", false), "u1")).toBe(true);
    expect(mayReadView(view("u1", false), "u2")).toBe(false);
    expect(mayReadView(view("u1", true), "u2")).toBe(true);
  });

  it("lets the owner change their own, and a project owner change a shared one but never a personal one", () => {
    expect(mayEditView(view("u1", false), "u1", false)).toBe(true);
    expect(mayEditView(view("u1", true), "u1", false)).toBe(true);
    expect(mayEditView(view("u1", true), "u2", true)).toBe(true);
    expect(mayEditView(view("u1", true), "u2", false)).toBe(false);
    expect(mayEditView(view("u1", false), "u2", true)).toBe(false);
  });
});

describe("toApiView", () => {
  it("says whether it is the reader's and whether they may change it, and fills what an old row lacks", () => {
    const stored = {
      _id: { toString: () => "v1" },
      name: "Mine",
      owner: { toString: () => "u1" },
      shared: false,
      sortField: "manual",
      sortDir: "asc",
      viewMode: "list",
    } as unknown as ISavedView & { _id: { toString(): string } };

    expect(toApiView(stored, "u1", false)).toMatchObject({
      _id: "v1",
      mine: true,
      canEdit: true,
      filters: {},
      search: "",
      groupBy: "",
      sprintScope: "all",
      hiddenColumns: [],
    });
    expect(toApiView(stored, "u2", true)).toMatchObject({ mine: false, canEdit: false });
  });
});
