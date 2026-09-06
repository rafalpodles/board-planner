import { describe, it, expect } from "vitest";
import { assessToolBudget, describeToolBudget, estimateToolTokens, MCP_TOOL_BUDGET } from "./tool-budget";

describe("assessToolBudget", () => {
  it("counts every enabled server together, because the turn carries them together", () => {
    const verdict = assessToolBudget([
      { name: "notion", count: 42 },
      { name: "github", count: 44 },
    ]);

    expect(verdict.total).toBe(86);
    expect(verdict.over).toBe(true);
    expect(verdict.budget).toBe(MCP_TOOL_BUDGET);
  });

  it("names the servers responsible, heaviest first", () => {
    const verdict = assessToolBudget([
      { name: "notion", count: 42 },
      { name: "github", count: 44 },
      { name: "tiny", count: 1 },
    ]);

    expect(verdict.heaviest.map((s) => s.name)).toEqual(["github", "notion", "tiny"]);
  });

  it("stays under budget for a narrowed pair — the configuration that fixed BP", () => {
    const verdict = assessToolBudget([
      { name: "notion", count: 5 },
      { name: "github", count: 8 },
    ]);

    expect(verdict.total).toBe(13);
    expect(verdict.over).toBe(false);
  });

  it("treats exactly the budget as within it", () => {
    expect(assessToolBudget([{ name: "one", count: MCP_TOOL_BUDGET }]).over).toBe(false);
    expect(assessToolBudget([{ name: "one", count: MCP_TOOL_BUDGET + 1 }]).over).toBe(true);
  });

  it("has nothing to say about a project with no MCP servers", () => {
    const verdict = assessToolBudget([]);

    expect(verdict.total).toBe(0);
    expect(verdict.over).toBe(false);
    expect(describeToolBudget(verdict)).toBe("");
  });
});

describe("describeToolBudget", () => {
  it("says the count, the budget and who is responsible", () => {
    const sentence = describeToolBudget(
      assessToolBudget([
        { name: "notion", count: 42 },
        { name: "github", count: 44 },
      ])
    );

    expect(sentence).toContain("86");
    expect(sentence).toContain(String(MCP_TOOL_BUDGET));
    expect(sentence).toContain("github (44)");
    expect(sentence).toContain("notion (42)");
  });

  it("is silent when the project is within budget, so it can be rendered unconditionally", () => {
    expect(describeToolBudget(assessToolBudget([{ name: "notion", count: 5 }]))).toBe("");
  });
});

describe("estimateToolTokens", () => {
  it("scales with the count so the picker can show a cost while choosing", () => {
    expect(estimateToolTokens(0)).toBe(0);
    expect(estimateToolTokens(13)).toBeLessThan(estimateToolTokens(86));
  });

  it("lands in the order of magnitude the BP measurement showed for 86 tools", () => {
    expect(estimateToolTokens(86)).toBeGreaterThan(20_000);
    expect(estimateToolTokens(86)).toBeLessThan(60_000);
  });
});

describe("a server that contributes nothing", () => {
  it("is left out of the blame list, so the log names only who is responsible", () => {
    const verdict = assessToolBudget([
      { name: "github", count: 44 },
      { name: "jira", count: 0 },
    ]);

    expect(verdict.heaviest.map((s) => s.name)).toEqual(["github"]);
    expect(describeToolBudget(verdict)).not.toContain("jira");
  });

  // Not "adding a zero does not change the total" — that was true before this filter existed and
  // could never have failed (BP-569 review 2). What the filter decides is the blame list.
  it("leaves a project with nothing but empty servers with no verdict to give", () => {
    const verdict = assessToolBudget([{ name: "a", count: 0 }, { name: "b", count: 0 }]);

    expect(verdict.heaviest).toEqual([]);
    expect(describeToolBudget(verdict)).toBe("");
  });
});
