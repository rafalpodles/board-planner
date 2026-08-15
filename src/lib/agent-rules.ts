import { AGENT_BUCKETS, AgentComposition, ApiAgentBlock } from "@/types";

/**
 * A bucket added after some agents were stored comes back undefined, and everything downstream
 * indexes by bucket. Filling the gap in one place keeps that from being every caller's problem.
 */
export function normaliseComposition(value?: Partial<AgentComposition> | null): AgentComposition {
  const out = {} as AgentComposition;
  for (const bucket of AGENT_BUCKETS) out[bucket] = value?.[bucket] ?? [];
  return out;
}

/**
 * Delivery used to be three lines of the worker's pipeline in a fixed order, and the gate order was
 * a comment in worker/src/gates/index.ts explaining why the static gates came first. Composing both
 * makes them expressible, and therefore breakable — so the guarantees the code used to hold by its
 * shape now have to be read off the sequence.
 */
export function sequenceOf(composition: AgentComposition): string[] {
  return AGENT_BUCKETS.flatMap((bucket) => composition[bucket] ?? []);
}

type Lookup = (key: string) => ApiAgentBlock | undefined;

/**
 * "broken" cannot run at all, or runs something before the thing meant to vet it. The server
 * refuses those: storing one only defers the failure to a machine, mid-task.
 *
 * "risky" runs exactly as composed. Merging unreviewed is the case: it works, and whether to do it
 * is the operator's call, so it is shown and never blocked.
 */
export type Severity = "broken" | "risky";

export interface Problem {
  severity: Severity;
  message: string;
}

// Gates whose implementation executes the content of the tree. protected-paths is what decides
// whether the agent was allowed to write the files they execute, so it has to have run first.
const EXECUTES_THE_TREE = new Set(["build", "test-run"]);

export function agentProblems(composition: AgentComposition, lookup: Lookup): Problem[] {
  const sequence = sequenceOf(composition);

  // An empty agent is a draft, not a broken one: every agent is empty between "New agent" and the
  // first thing dragged into it. It is refused where it would actually reach a machine — see
  // isRunnable, used by the project-default route.
  if (sequence.length === 0) return [];

  // Last occurrence, not first: a composition may carry the same block twice, and these rules ask
  // "does this still hold at the end", not "did it ever hold".
  const lastAt = (key: string) => sequence.lastIndexOf(key);
  const firstAt = (key: string) => sequence.indexOf(key);
  const kindOf = (key: string) => lookup(key)?.gateKind;

  const writesAt = sequence.reduce<number[]>(
    (acc, key, i) => (lookup(key)?.capability === "edit" ? [...acc, i] : acc),
    []
  );
  const firstWriteAt = writesAt[0] ?? -1;
  const lastWriteAt = writesAt[writesAt.length - 1] ?? -1;

  const problems: Problem[] = [];
  const mergeAt = firstAt("merge");
  const protectedAt = firstAt("protected-paths");

  if (mergeAt !== -1) {
    // Reviewed means reviewed *after the last thing that wrote*. A review sitting in an earlier
    // bucket judges an empty tree, approves it, and would satisfy a check that only asked whether
    // one appeared before the merge.
    const reviewedInTime = sequence.some(
      (key, i) => kindOf(key) === "review" && i > lastWriteAt && i < mergeAt
    );
    if (!reviewedInTime) {
      problems.push({
        severity: "risky",
        message:
          "Merge runs with nothing having reviewed the finished change. Put a Reviewed gate after the last step that writes, or take the Merge step out and let a human decide.",
      });
    }

    const prAt = firstAt("pull-request");
    if (prAt === -1 || prAt > mergeAt) {
      problems.push({
        severity: "broken",
        message: "Merge runs without a pull request to merge. Put Pull request before it.",
      });
    }
  }

  const prAt = firstAt("pull-request");
  if (prAt !== -1 && (firstAt("push") === -1 || firstAt("push") > prAt)) {
    problems.push({
      severity: "broken",
      message: "Pull request opens on a branch that was never pushed. Put Push before it.",
    });
  }

  // Only an agent that writes needs a push. One that reads and judges has nothing to send, and
  // demanding it there would be noise.
  if (lastWriteAt !== -1 && (lastAt("push") === -1 || lastAt("push") < lastWriteAt)) {
    problems.push({
      severity: "broken",
      message:
        lastAt("push") === -1
          ? "Nothing pushes the work, so it stays in a worktree on the machine and nobody can reach it. Add a Push step."
          : "Push runs before the last step that changes files, so what it sends is not the finished work.",
    });
  }

  // Nothing may execute what a step wrote before protected-paths has read it. This was the reason
  // the old pipeline hardcoded its gate order; composing the order is what put it at risk.
  if (firstWriteAt !== -1) {
    const executesEarly = sequence.some(
      (key, i) =>
        EXECUTES_THE_TREE.has(kindOf(key) ?? "") &&
        i > firstWriteAt &&
        (protectedAt === -1 || protectedAt > i)
    );
    if (executesEarly) {
      problems.push({
        severity: "broken",
        message:
          "A gate runs the project's own build or test script before Protected files has read the change, so a script the agent wrote would execute before anything checked whether it was allowed to write it. Put Protected files first.",
      });
    }
  }

  return problems;
}

/** Whether a worker handed this agent would have anything to do. */
export function isRunnable(composition: AgentComposition): boolean {
  return sequenceOf(composition).length > 0;
}

export function brokenProblems(composition: AgentComposition, lookup: Lookup): Problem[] {
  return agentProblems(composition, lookup).filter((p) => p.severity === "broken");
}
