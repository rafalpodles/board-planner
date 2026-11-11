import { describe, it, expect } from "vitest";
import type { AnyColumn } from "@/lib/columns";
import type { ApiAgentBlock, ApiCustomField } from "@/types";
import {
  columnsInOrder,
  columnsUpdated,
  columnsWithout,
  compositionFrom,
  findAgent,
  findBlock,
  optionsUpdated,
  optionsWithout,
} from "./setup-edit";

const block = (key: string, name: string, kind: "step" | "gate" = "step") => ({ _id: `id-${key}`, key, name, kind }) as ApiAgentBlock;
const BLOCKS = [block("implement", "Implement"), block("review", "Code review"), block("diff-size", "Size", "gate"), block("size-2", "Size", "gate")];

describe("findBlock", () => {
  it("takes a key before a name, in any case", () => {
    expect(findBlock("REVIEW", BLOCKS).key).toBe("review");
    expect(findBlock("code review", BLOCKS).key).toBe("review");
  });

  it("refuses a name two blocks share, naming their keys", () => {
    expect(() => findBlock("size", BLOCKS)).toThrow(/2 blocks are named "size" — pass the key of one: diff-size, size-2/);
  });

  it("says where to look for one that does not exist", () => {
    expect(() => findBlock("deploy", BLOCKS)).toThrow(/No step or gate "deploy".*list_agent_blocks/);
  });
});

describe("compositionFrom", () => {
  it("names every bucket, by key, and keeps a gate's params only where given", () => {
    expect(
      compositionFrom({ implementation: ["Implement"], verification: [{ block: "diff-size", params: { maxLines: "200" } }, { block: "review" }] }, BLOCKS)
    ).toEqual({
      analysis: [],
      implementation: [{ key: "implement" }],
      verification: [{ key: "diff-size", params: { maxLines: "200" } }, { key: "review" }],
      delivery: [],
    });
  });

  it("refuses the whole composition when one entry names nothing", () => {
    expect(() => compositionFrom({ implementation: ["implement", "nope"] }, BLOCKS)).toThrow(/"nope"/);
  });
});

describe("findAgent", () => {
  const AGENTS = [
    { _id: "a1", name: "Ship", scope: "project", projectId: "p1", projectName: "Web" },
    { _id: "a2", name: "ship", scope: "project", projectId: "p2", projectName: "App" },
    { _id: "a3", name: "Mine", scope: "user", projectId: null },
  ];

  it("picks the board's own agent when its project is named", () => {
    expect(findAgent("SHIP", AGENTS, "p2")._id).toBe("a2");
  });

  it("refuses a name shared across boards when none is named, listing them", () => {
    expect(() => findAgent("ship", AGENTS)).toThrow(/2 agents are named "ship" \(project Web, project App\)/);
  });

  it("tells another board's agent from one that does not exist", () => {
    expect(() => findAgent("Ship", AGENTS, "p3")).toThrow(/belongs to another project/);
    expect(() => findAgent("Ghost", AGENTS)).toThrow(/not found/);
  });

  it("finds a personal agent whatever the board", () => {
    expect(findAgent("mine", AGENTS, "p1")._id).toBe("a3");
  });
});

const col = (id: string, role: AnyColumn["role"], order: number, extra: Partial<AnyColumn> = {}): AnyColumn => ({
  id,
  label: id.toUpperCase(),
  color: "#000000",
  role,
  order,
  ...extra,
});
const BOARD = [col("todo", "approved", 0), col("doing", "active", 1), col("qa", "review", 2, { triggersPmReview: true }), col("done", "done", 3)];

describe("column edits", () => {
  it("changes only the column named and leaves the rest as stored", () => {
    const after = columnsUpdated(BOARD, "QA", { role: "blocked", triggersPmReview: false });
    expect(after.find((c) => c.id === "qa")).toMatchObject({ role: "blocked", triggersPmReview: false, label: "QA" });
    expect(after.filter((c) => c.id !== "qa")).toEqual(BOARD.filter((c) => c.id !== "qa"));
  });

  it("removes a column and closes the gap in the order", () => {
    expect(columnsWithout(BOARD, "doing").map((c) => [c.id, c.order])).toEqual([["todo", 0], ["qa", 1], ["done", 2]]);
  });

  it("works on the default columns of a board that stores none", () => {
    expect(columnsWithout([], "planned").some((c) => c.id === "planned")).toBe(false);
  });

  it("reorders by id or label and refuses a list that leaves a column out or names one twice", () => {
    expect(columnsInOrder(BOARD, ["done", "QA", "todo", "doing"]).map((c) => [c.id, c.order])).toEqual([
      ["done", 0],
      ["qa", 1],
      ["todo", 2],
      ["doing", 3],
    ]);
    expect(() => columnsInOrder(BOARD, ["done", "qa"])).toThrow(/Missing: TODO \(todo\), DOING \(doing\)/);
    expect(() => columnsInOrder(BOARD, ["done", "done", "qa", "todo", "doing"])).toThrow(/named twice/);
  });
});

describe("option edits", () => {
  const field = {
    _id: "f1",
    name: "Size",
    fieldType: "dropdown",
    options: [
      { id: "s", value: "Small", color: "#111111", order: 0 },
      { id: "l", value: "Large", color: "#222222", order: 1 },
    ],
  } as unknown as ApiCustomField;

  it("renames by value and keeps the id, so tasks holding it keep it", () => {
    expect(optionsUpdated(field, "small", { value: "Tiny" })).toEqual([
      { id: "s", value: "Tiny", color: "#111111" },
      { id: "l", value: "Large", color: "#222222" },
    ]);
  });

  it("recolours by id and keeps the name", () => {
    expect(optionsUpdated(field, "l", { color: "#333333" })[1]).toEqual({ id: "l", value: "Large", color: "#333333" });
  });

  it("removes one and keeps the others' ids", () => {
    expect(optionsWithout(field, "Large")).toEqual([{ id: "s", value: "Small", color: "#111111" }]);
  });

  it("names the options there are when one is missing", () => {
    expect(() => optionsWithout(field, "Medium")).toThrow(/No option "Medium" on Size. Options: Small, Large/);
  });
});
