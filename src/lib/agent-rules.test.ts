import { describe, it, expect } from "vitest";
import { agentProblems, sequenceOf } from "./agent-rules";
import { AgentComposition, ApiAgentBlock } from "@/types";

function block(over: Partial<ApiAgentBlock> & Pick<ApiAgentBlock, "key">): ApiAgentBlock {
  return {
    _id: over.key,
    kind: "gate",
    name: over.key,
    description: "",
    builtIn: true,
    gateKind: "",
    params: {},
    prompt: "",
    capability: "read-only",
    model: "",
    fallbackModel: "",
    deterministic: false,
    ...over,
  } as ApiAgentBlock;
}

const BLOCKS: ApiAgentBlock[] = [
  block({ key: "implement", kind: "step", capability: "edit" }),
  block({ key: "analyse", kind: "step", capability: "read-only" }),
  block({ key: "push", kind: "step", deterministic: true }),
  block({ key: "pull-request", kind: "step", deterministic: true }),
  block({ key: "merge", kind: "step", deterministic: true }),
  block({ key: "review", gateKind: "review" }),
  block({ key: "security-review", gateKind: "review" }),
  block({ key: "diff-size", gateKind: "diff-size" }),
];

const lookup = (key: string) => BLOCKS.find((b) => b.key === key);

function composition(over: Partial<AgentComposition> = {}): AgentComposition {
  return { analysis: [], implementation: [], verification: [], delivery: [], ...over };
}

describe("sequenceOf", () => {
  it("reads the buckets in order, so a rule spanning two of them sees them as one list", () => {
    const seq = sequenceOf(
      composition({ implementation: ["implement"], verification: ["review"], delivery: ["push"] })
    );
    expect(seq).toEqual(["implement", "review", "push"]);
  });

  // An agent stored before a bucket existed comes back without it, and every rule indexes by bucket
  it("survives a bucket the stored agent does not have", () => {
    const partial = { implementation: ["implement"] } as unknown as AgentComposition;
    expect(sequenceOf(partial)).toEqual(["implement"]);
  });
});

describe("agentProblems", () => {
  it("passes the composition the worker runs today", () => {
    const problems = agentProblems(
      composition({
        implementation: ["implement"],
        verification: ["diff-size", "review"],
        delivery: ["push", "pull-request"],
      }),
      lookup
    );
    expect(problems).toEqual([]);
  });

  it("refuses a merge that nothing reviewed", () => {
    const problems = agentProblems(
      composition({
        implementation: ["implement"],
        verification: ["diff-size"],
        delivery: ["push", "pull-request", "merge"],
      }),
      lookup
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/nothing having reviewed/);
  });

  // The gate is recognised by what it does, not by the key somebody gave it
  it("accepts any review-kind gate as the reviewer, not just the one named review", () => {
    const problems = agentProblems(
      composition({
        implementation: ["implement"],
        verification: ["security-review"],
        delivery: ["push", "pull-request", "merge"],
      }),
      lookup
    );
    expect(problems).toEqual([]);
  });

  it("refuses a review that only happens after the merge", () => {
    const problems = agentProblems(
      composition({
        implementation: ["implement"],
        delivery: ["push", "pull-request", "merge", "review"],
      }),
      lookup
    );
    expect(problems.some((p) => /nothing having reviewed/.test(p))).toBe(true);
  });

  it("refuses a merge with no pull request to merge", () => {
    const problems = agentProblems(
      composition({
        implementation: ["implement"],
        verification: ["review"],
        delivery: ["push", "merge"],
      }),
      lookup
    );
    expect(problems).toContain(
      "Merge runs without a pull request to merge. Put Pull request before it."
    );
  });

  it("refuses a pull request on a branch nobody pushed", () => {
    const problems = agentProblems(
      composition({ implementation: ["implement"], delivery: ["pull-request"] }),
      lookup
    );
    expect(problems.some((p) => /never pushed/.test(p))).toBe(true);
  });

  it("refuses work that nothing sends anywhere", () => {
    const problems = agentProblems(
      composition({ implementation: ["implement"], verification: ["diff-size"] }),
      lookup
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/stays in a worktree/);
  });

  // The point of the rule is the writing, not the pushing: an agent that only reads has nothing
  // to send and must not be nagged for it
  it("says nothing about push when the agent never writes", () => {
    const problems = agentProblems(
      composition({ analysis: ["analyse"], verification: ["diff-size", "review"] }),
      lookup
    );
    expect(problems).toEqual([]);
  });

  it("refuses a push that runs before the last step that writes", () => {
    const problems = agentProblems(
      composition({ implementation: ["push", "implement"] }),
      lookup
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/before the last step that changes files/);
  });

  it("names every problem at once rather than stopping at the first", () => {
    const problems = agentProblems(
      composition({ implementation: ["implement"], delivery: ["merge"] }),
      lookup
    );
    expect(problems).toHaveLength(3);
  });
});
