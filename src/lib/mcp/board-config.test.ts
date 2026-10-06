import { describe, it, expect } from "vitest";
import { COLOUR_PARAM, columnSummary, fieldSummary, findColumn, findField, optionLines, requireOwner } from "./board-config";
import type { ApiCustomField, ApiProjectColumn } from "@/types";

const field = (over: Partial<ApiCustomField>): ApiCustomField =>
  ({ _id: "6a70afff45d39cd9bc8bb5d3", name: "Difficulty", fieldType: "dropdown", options: [], ...over }) as ApiCustomField;

const column = (id: string, label: string, order = 0): ApiProjectColumn => ({
  _id: `c-${id}`,
  id,
  label,
  color: "#6b7280",
  role: "backlog",
  order,
  triggersPmReview: false,
});

describe("findField", () => {
  const fields = [field({}), field({ _id: "6a70afff45d39cd9bc8bb5d4", name: "Notes", fieldType: "text" })];

  it("takes a name in any case, or the id", () => {
    expect(findField("  difficulty ", fields).name).toBe("Difficulty");
    expect(findField("6A70AFFF45D39CD9BC8BB5D4", fields).name).toBe("Notes");
  });

  it("names the fields there are when none matches", () => {
    expect(() => findField("Nope", fields)).toThrow(/No field "Nope".*Difficulty, Notes/);
  });

  it("does not take another field's name for an id", () => {
    expect(() => findField("6a70afff45d39cd9bc8bb5ff", fields)).toThrow(/No field/);
  });
});

describe("findColumn", () => {
  const columns = [column("todo", "To Do"), column("doing", "Doing"), column("also", "Doing")];

  it("takes an id, or a label in any case", () => {
    expect(findColumn("TODO", columns).id).toBe("todo");
    expect(findColumn("to do", columns).id).toBe("todo");
  });

  it("prefers an id over a label that happens to be the same word, when no other column carries it as a label", () => {
    expect(findColumn("doing", [column("doing", "Working"), column("also", "Other")]).id).toBe("doing");
  });

  it("refuses an id that another column also carries as its label, naming both ids", () => {
    expect(() => findColumn("doing", columns)).toThrow(/id of column doing and the label of column also/);
  });

  it("refuses a word that is one column's id and another column's label, naming both ids", () => {
    const board = [column("in_progress", "Review"), column("x", "in_progress")];

    expect(() => findColumn("in_progress", board)).toThrow(/id of column in_progress and the label of column x.*"Review"/);
  });

  it("does not refuse a column whose label repeats its own id", () => {
    expect(findColumn("Doing", [column("doing", "Doing"), column("other", "Other")]).id).toBe("doing");
  });

  it("resolves over the seven defaults for a board stored with no columns", () => {
    expect(findColumn<ApiProjectColumn>("in progress", []).id).toBe("in_progress");
    expect(findColumn<ApiProjectColumn>("done", undefined).id).toBe("done");
  });

  it("refuses a label two columns share, naming their ids", () => {
    expect(() => findColumn("Doing ", [column("a", "Doing"), column("b", "Doing")])).toThrow(/2 columns are labelled "Doing".*a, b/);
  });

  it("names the columns there are when none matches", () => {
    expect(() => findColumn("Nope", columns)).toThrow(/No column "Nope".*To Do \(todo\)/);
  });
});

describe("requireOwner", () => {
  it("lets an owner through", () => {
    expect(() => requireOwner({ _id: "p", canAdmin: true }, "bp", "add a column")).not.toThrow();
  });

  it.each([false, undefined])("refuses canAdmin %s, saying nothing was changed", (canAdmin) => {
    expect(() => requireOwner({ _id: "p", canAdmin }, "bp", "add a column")).toThrow(
      "Only a project owner can add a column on BP, as in the app. Nothing was changed."
    );
  });
});

describe("summaries", () => {
  it("shows a dropdown's options in order, with a legacy string option as one", () => {
    expect(
      optionLines([{ id: "b", value: "B", color: "#000000", order: 1 }, { id: "a", value: "A", color: "#111111", order: 0 }, "Legacy"] as never)
    ).toEqual([
      { id: "a", value: "A", color: "#111111" },
      { id: "b", value: "B", color: "#000000" },
      { id: "Legacy", value: "Legacy", color: "#64748b" },
    ]);
  });

  it("gives only an option field its options", () => {
    expect(fieldSummary(field({ options: [{ id: "a", value: "A", color: "#111111", order: 0 }] }))).toMatchObject({
      id: "6a70afff45d39cd9bc8bb5d3",
      options: [{ id: "a", value: "A", color: "#111111" }],
    });
    expect(fieldSummary(field({ fieldType: "text" }))).not.toHaveProperty("options");
  });

  it("keeps a column to what an agent needs", () => {
    expect(columnSummary(column("todo", "To Do", 3))).toEqual({ id: "todo", label: "To Do", role: "backlog", color: "#6b7280", order: 3 });
  });
});

describe("COLOUR_PARAM", () => {
  it("takes #rrggbb only", () => {
    expect(COLOUR_PARAM.safeParse("#a1B2c3").success).toBe(true);
    expect(COLOUR_PARAM.safeParse(undefined).success).toBe(true);
    for (const bad of ["red", "#fff", "a1b2c3", "#a1b2c3;x", "url(x)"]) expect(COLOUR_PARAM.safeParse(bad).success).toBe(false);
  });
});
