import { describe, it, expect } from "vitest";
import {
  assessToolBudget,
  describeToolBudget,
  estimateToolTokens,
  MCP_TOOL_BUDGET,
  TOKENS_PER_TOOL_ESTIMATE,
} from "./tool-budget";

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

    // The whole sentence, not substrings of it: asserting only "86" and "40" left the claim it
    // makes free to be inverted — "below the 40", "turns get faster" (BP-569 review 3)
    expect(sentence).toBe(
      "86 MCP tools would be sent to the model on every call of a turn, above the 40 this agent " +
        "is sized for: github (44), notion (42). Turns get slower and may end without an answer. " +
        "Narrow a server's tool list to fix it."
    );
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

  // Bounds wide enough to admit 233-697 tokens per tool proved nothing about the number; the
  // constant is a stated estimate, so state it (BP-569 review 3)
  it("is the measured per-tool estimate, times the count", () => {
    expect(TOKENS_PER_TOOL_ESTIMATE).toBe(350);
    expect(estimateToolTokens(86)).toBe(30_100);
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

describe("a total that could not be counted in full", () => {
  it("is presented as a floor rather than a figure", () => {
    const sentence = describeToolBudget(
      assessToolBudget([{ name: "github", count: 44 }], undefined, true)
    );

    expect(sentence).toContain("At least 44 MCP tools");
  });

  // The control: a complete count states the number plainly
  it("is stated plainly when every server was reached", () => {
    const sentence = describeToolBudget(assessToolBudget([{ name: "github", count: 44 }]));

    expect(sentence).toContain("44 MCP tools");
    expect(sentence).not.toContain("At least");
  });
});

describe("the budget argument", () => {
  it("is honoured, so a caller can ask about a different ceiling", () => {
    expect(assessToolBudget([{ name: "a", count: 20 }], 10).over).toBe(true);
    expect(assessToolBudget([{ name: "a", count: 20 }], 30).over).toBe(false);
  });
});
