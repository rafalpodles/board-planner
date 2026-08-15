import { AGENT_BUCKETS, AgentComposition, ApiAgentBlock } from "@/types";

/**
 * A bucket added after some agents were stored comes back undefined, and everything downstream
 * indexes by bucket. Filling the gap in one place keeps that from being every caller's problem.
 */
export function normaliseComposition(
  value?: Partial<AgentComposition> | null
): AgentComposition {
  const out = {} as AgentComposition;
  for (const bucket of AGENT_BUCKETS) out[bucket] = value?.[bucket] ?? [];
  return out;
}

/**
 * Delivery used to be three lines of the worker's pipeline in a fixed order. Composing it makes the
 * order expressible, and therefore breakable — so the guarantees the code used to hold by shape now
 * have to be read off the sequence.
 */
export function sequenceOf(composition: AgentComposition): string[] {
  return AGENT_BUCKETS.flatMap((bucket) => composition[bucket] ?? []);
}

type Lookup = (key: string) => ApiAgentBlock | undefined;

/**
 * "broken" cannot run at all — merging something never opened, opening a branch never pushed. The
 * server refuses those, because storing them only defers the failure to a machine.
 *
 * "risky" runs exactly as composed. Merging unreviewed is the case: it works, and whether to do it
 * is the operator's call, so it is shown and never blocked.
 */
export type Severity = "broken" | "risky";

export interface Problem {
  severity: Severity;
  message: string;
}

export function agentProblems(composition: AgentComposition, lookup: Lookup): Problem[] {
  const sequence = sequenceOf(composition);
  const at = (key: string) => sequence.indexOf(key);
  const before = (first: string, second: string) =>
    at(first) !== -1 && (at(second) === -1 || at(second) > at(first));

  const problems: Problem[] = [];
  const mergeAt = at("merge");

  if (mergeAt !== -1 && !sequence.slice(0, mergeAt).some((k) => lookup(k)?.gateKind === "review")) {
    problems.push({
      severity: "risky",
      message:
        "Merge runs with nothing having reviewed the change. Put a Reviewed gate before it, or take the Merge step out and let a human decide.",
    });
  }

  if (mergeAt !== -1 && !before("pull-request", "merge")) {
    problems.push({
      severity: "broken",
      message: "Merge runs without a pull request to merge. Put Pull request before it.",
    });
  }

  if (at("pull-request") !== -1 && !before("push", "pull-request")) {
    problems.push({
      severity: "broken",
      message: "Pull request opens on a branch that was never pushed. Put Push before it.",
    });
  }

  // Only an agent that writes needs a push. One that reads and judges has nothing to send, and
  // demanding it there would be noise.
  const lastWriteAt = sequence.reduce(
    (last, key, i) => (lookup(key)?.capability === "edit" ? i : last),
    -1
  );
  if (lastWriteAt !== -1 && (at("push") === -1 || at("push") < lastWriteAt)) {
    problems.push({
      severity: "broken",
      message:
        at("push") === -1
          ? "Nothing pushes the work, so it stays in a worktree on the machine and nobody can reach it. Add a Push step."
          : "Push runs before the last step that changes files, so what it sends is not the finished work.",
    });
  }

  return problems;
}

export function brokenProblems(composition: AgentComposition, lookup: Lookup): Problem[] {
  return agentProblems(composition, lookup).filter((p) => p.severity === "broken");
}
