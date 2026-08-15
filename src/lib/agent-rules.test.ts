import { describe, it, expect } from "vitest";
import {
  agentProblems,
  brokenProblems,
  isRunnable,
  keysOf,
  normaliseComposition,
  sequenceOf,
} from "./agent-rules";
import { AgentComposition, ApiAgentBlock, StoredComposition } from "@/types";

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
  block({ key: "protected-paths", gateKind: "protected-paths" }),
  block({ key: "build", gateKind: "build" }),
  block({ key: "test-run", gateKind: "test-run" }),
];

const lookup = (key: string) => BLOCKS.find((b) => b.key === key);

// Written as bare keys on purpose: that is the shape stored before entries existed, so every
// assertion below also exercises the coercion that reads it.
function composition(over: StoredComposition = {}): AgentComposition {
  return normaliseComposition(over);
}

describe("sequenceOf", () => {
  it("reads the buckets in order, so a rule spanning two of them sees them as one list", () => {
    const seq = keysOf(
      composition({ implementation: ["implement"], verification: ["review"], delivery: ["push"] })
    );
    expect(seq).toEqual(["implement", "review", "push"]);
  });

  // An agent stored before a bucket existed comes back without it, and every rule indexes by bucket
  it("survives a bucket the stored agent does not have", () => {
    expect(keysOf(composition({ implementation: ["implement"] }))).toEqual(["implement"]);
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
    expect(problems[0].message).toMatch(/nothing having reviewed/);
    expect(problems[0].severity).toBe("risky");
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
    expect(problems.some((p) => /nothing having reviewed/.test(p.message))).toBe(true);
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
    expect(problems).toContainEqual({
      severity: "broken",
      message: "Merge runs without a pull request to merge. Put Pull request before it.",
    });
  });

  it("refuses a pull request on a branch nobody pushed", () => {
    const problems = agentProblems(
      composition({ implementation: ["implement"], delivery: ["pull-request"] }),
      lookup
    );
    expect(problems.some((p) => /never pushed/.test(p.message))).toBe(true);
  });

  it("refuses work that nothing sends anywhere", () => {
    const problems = agentProblems(
      composition({ implementation: ["implement"], verification: ["diff-size"] }),
      lookup
    );
    expect(problems).toHaveLength(1);
    expect(problems[0].message).toMatch(/stays in a worktree/);
    expect(problems[0].severity).toBe("broken");
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
    expect(problems[0].message).toMatch(/before the last step that changes files/);
  });

  it("names every problem at once rather than stopping at the first", () => {
    const problems = agentProblems(
      composition({ implementation: ["implement"], delivery: ["merge"] }),
      lookup
    );
    expect(problems).toHaveLength(3);
  });
});

describe("brokenProblems", () => {
  // The operator chose to allow this one; refusing it on save would take the choice back
  it("leaves an unreviewed merge to the operator", () => {
    const broken = brokenProblems(
      composition({
        implementation: ["implement"],
        delivery: ["push", "pull-request", "merge"],
      }),
      lookup
    );
    expect(broken).toEqual([]);
  });

  it("keeps the ones that cannot run at all", () => {
    const broken = brokenProblems(
      composition({ implementation: ["implement"], delivery: ["merge"] }),
      lookup
    );
    expect(broken.map((p) => p.severity)).toEqual(["broken", "broken"]);
  });
});

describe("rules the shape of the old pipeline used to guarantee", () => {
  // worker/src/gates/index.ts said it outright: the static gates run first because build runs npm
  // on a tree the agent just wrote, executing its content before any gate has read it
  it("refuses a build that runs on written code before protected-paths has read it", () => {
    const problems = agentProblems(
      composition({
        implementation: ["implement"],
        verification: ["build", "protected-paths", "review"],
        delivery: ["push", "pull-request"],
      }),
      lookup
    );
    expect(problems.some((p) => /before .*protected/i.test(p.message))).toBe(true);
    expect(problems.find((p) => /before .*protected/i.test(p.message))?.severity).toBe("broken");
  });

  it("accepts the same gates in the order the worker used to hardcode", () => {
    const problems = agentProblems(
      composition({
        implementation: ["implement"],
        verification: ["protected-paths", "build", "review"],
        delivery: ["push", "pull-request"],
      }),
      lookup
    );
    expect(problems).toEqual([]);
  });

  // Nothing was written, so there is nothing whose content the build could execute
  it("says nothing about ordering when no step writes", () => {
    const problems = agentProblems(
      composition({ verification: ["build", "protected-paths"] }),
      lookup
    );
    expect(problems).toEqual([]);
  });

  // The review has to judge the finished work, not an empty tree in an earlier bucket
  it("refuses a review that ran before the last thing that wrote", () => {
    const problems = agentProblems(
      composition({
        analysis: ["review"],
        implementation: ["implement"],
        verification: ["protected-paths"],
        delivery: ["push", "pull-request", "merge"],
      }),
      lookup
    );
    expect(problems.some((p) => /nothing having reviewed/.test(p.message))).toBe(true);
  });

  it("accepts a review that comes after the writing", () => {
    const problems = agentProblems(
      composition({
        implementation: ["implement"],
        verification: ["protected-paths", "review"],
        delivery: ["push", "pull-request", "merge"],
      }),
      lookup
    );
    expect(problems).toEqual([]);
  });

  // A composition can carry the same block twice, so a rule reading the first occurrence is wrong
  it("reads the last push, not the first, when the agent pushes twice", () => {
    const problems = agentProblems(
      composition({
        implementation: ["push", "implement"],
        delivery: ["push", "pull-request"],
      }),
      lookup
    );
    expect(problems).toEqual([]);
  });

  // Every agent is empty between "New agent" and the first block dragged in, so an empty one is a
  // draft. isRunnable is what the project-default route asks before pointing a worker at it.
  it("treats an empty agent as a draft rather than a broken composition", () => {
    expect(agentProblems(composition(), lookup)).toEqual([]);
    expect(isRunnable(composition())).toBe(false);
    expect(isRunnable(composition({ implementation: ["implement"], delivery: ["push"] }))).toBe(true);
  });
});

describe("composition entries", () => {
  // The shape change that makes per-position configuration possible at all
  it("carries parameters set on a position, not only on the block", () => {
    const composed = normaliseComposition({
      verification: [{ key: "diff-size", params: { maxLines: "50" } }, "review"],
    });
    expect(sequenceOf(composed)).toEqual([
      { key: "diff-size", params: { maxLines: "50" } },
      { key: "review", params: undefined },
    ]);
  });

  it("reads a composition stored as bare keys, so nothing needs migrating", () => {
    expect(keysOf(normaliseComposition({ delivery: ["push", "pull-request"] }))).toEqual([
      "push",
      "pull-request",
    ]);
  });
});
