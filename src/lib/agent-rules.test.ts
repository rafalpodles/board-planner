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
  block({ key: "protected-files-strict", gateKind: "protected-paths" }),
  block({ key: "polish", kind: "step", capability: "edit" }),
  block({ key: "build", gateKind: "build" }),
  block({ key: "test-run", gateKind: "test-run" }),
  block({ key: "tests-pass", gateKind: "test-run", name: "Tests pass" }),
];

const lookup = (key: string) => BLOCKS.find((b) => b.key === key);

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

  it("refuses a test-run that comes before protected-paths, exactly as it refuses a build", () => {
    const problems = agentProblems(
      composition({
        implementation: ["implement"],
        verification: ["test-run", "protected-paths"],
        delivery: ["push"],
      }),
      lookup
    );
    expect(problems.some((p) => p.severity === "broken" && /protected/i.test(p.message))).toBe(true);
  });

  it("refuses a second write that no protected-paths gate stands between and the build", () => {
    const problems = agentProblems(
      composition({
        implementation: ["implement"],
        verification: ["protected-paths", "polish", "build"],
        delivery: ["push"],
      }),
      lookup
    );
    expect(problems.some((p) => p.severity === "broken" && /protected/i.test(p.message))).toBe(true);
  });

  it("accepts a second protected-paths gate after the second write", () => {
    const problems = agentProblems(
      composition({
        implementation: ["implement"],
        verification: ["protected-paths", "polish", "protected-files-strict", "build"],
        delivery: ["push"],
      }),
      lookup
    );
    expect(problems).toEqual([]);
  });

  it("accepts any protected-paths-kind gate as the guard, not just the one named protected-paths", () => {
    const problems = agentProblems(
      composition({
        implementation: ["implement"],
        verification: ["protected-files-strict", "build"],
        delivery: ["push"],
      }),
      lookup
    );
    expect(problems).toEqual([]);
  });

  it("refuses a gate placed after Merge", () => {
    const problems = agentProblems(
      composition({
        implementation: ["implement"],
        verification: ["protected-paths"],
        delivery: ["push", "pull-request", "merge", "review"],
      }),
      lookup
    );
    expect(problems.some((p) => p.severity === "broken" && /not last/i.test(p.message))).toBe(true);
  });

  it("names the blocks after Merge the way the rest of the product does", () => {
    const problems = agentProblems(
      composition({
        implementation: ["implement"],
        verification: ["protected-paths"],
        delivery: ["push", "pull-request", "merge", "tests-pass"],
      }),
      lookup
    );
    const notLast = problems.find((p) => /not last/i.test(p.message))!;
    expect(notLast).toBeTruthy();
    expect(notLast.message).toContain("Tests pass");
    expect(notLast.message).not.toContain("tests-pass");
  });

  it("accepts the same agent with Merge at the end", () => {
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

  it("says nothing about ordering when no step writes", () => {
    const problems = agentProblems(
      composition({ verification: ["build", "protected-paths"] }),
      lookup
    );
    expect(problems).toEqual([]);
  });

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

  it("treats an empty agent as a draft rather than a broken composition", () => {
    expect(agentProblems(composition(), lookup)).toEqual([]);
    expect(isRunnable(composition())).toBe(false);
    expect(isRunnable(composition({ implementation: ["implement"], delivery: ["push"] }))).toBe(true);
  });
});

describe("composition entries", () => {
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
