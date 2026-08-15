import { AGENT_BUCKETS, AgentComposition, ApiAgentBlock } from "@/types";

/**
 * Delivery used to be three lines of the worker's pipeline in a fixed order. Composing it makes the
 * order expressible, and therefore breakable — so the guarantees the code used to hold by shape now
 * have to be read off the sequence.
 */
export function sequenceOf(composition: AgentComposition): string[] {
  return AGENT_BUCKETS.flatMap((bucket) => composition[bucket] ?? []);
}

type Lookup = (key: string) => ApiAgentBlock | undefined;

export function agentProblems(composition: AgentComposition, lookup: Lookup): string[] {
  const sequence = sequenceOf(composition);
  const at = (key: string) => sequence.indexOf(key);
  const before = (first: string, second: string) =>
    at(first) !== -1 && (at(second) === -1 || at(second) > at(first));

  const problems: string[] = [];
  const mergeAt = at("merge");

  if (mergeAt !== -1 && !sequence.slice(0, mergeAt).some((k) => lookup(k)?.gateKind === "review")) {
    problems.push(
      "Merge runs with nothing having reviewed the change. Put a Reviewed gate before it, or take the Merge step out and let a human decide."
    );
  }

  if (mergeAt !== -1 && !before("pull-request", "merge")) {
    problems.push("Merge runs without a pull request to merge. Put Pull request before it.");
  }

  if (at("pull-request") !== -1 && !before("push", "pull-request")) {
    problems.push("Pull request opens on a branch that was never pushed. Put Push before it.");
  }

  // Only an agent that writes needs a push. One that reads and judges has nothing to send, and
  // demanding it there would be noise.
  const lastWriteAt = sequence.reduce(
    (last, key, i) => (lookup(key)?.capability === "edit" ? i : last),
    -1
  );
  if (lastWriteAt !== -1 && (at("push") === -1 || at("push") < lastWriteAt)) {
    problems.push(
      at("push") === -1
        ? "Nothing pushes the work, so it stays in a worktree on the machine and nobody can reach it. Add a Push step."
        : "Push runs before the last step that changes files, so what it sends is not the finished work."
    );
  }

  return problems;
}
