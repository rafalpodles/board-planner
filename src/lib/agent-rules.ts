import {
  AGENT_BUCKETS,
  AgentComposition,
  ApiAgentBlock,
  CompositionEntry,
  StoredComposition,
} from "@/types";

export function normaliseComposition(value?: StoredComposition | null): AgentComposition {
  const out = {} as AgentComposition;
  for (const bucket of AGENT_BUCKETS) {
    out[bucket] = (value?.[bucket] ?? []).map((entry) =>
      typeof entry === "string" ? { key: entry } : { key: entry.key, params: entry.params }
    );
  }
  return out;
}

export function sequenceOf(composition: AgentComposition): CompositionEntry[] {
  return AGENT_BUCKETS.flatMap((bucket) => composition[bucket] ?? []);
}

export function keysOf(composition: AgentComposition): string[] {
  return sequenceOf(composition).map((entry) => entry.key);
}

type Lookup = (key: string) => ApiAgentBlock | undefined;

export type Severity = "broken" | "risky";

export interface Problem {
  severity: Severity;
  message: string;
}

const EXECUTES_THE_TREE = new Set(["build", "test-run"]);

export function agentProblems(composition: AgentComposition, lookup: Lookup): Problem[] {
  const sequence = keysOf(composition);

  if (sequence.length === 0) return [];

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

  if (mergeAt !== -1) {
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

  if (lastWriteAt !== -1 && (lastAt("push") === -1 || lastAt("push") < lastWriteAt)) {
    problems.push({
      severity: "broken",
      message:
        lastAt("push") === -1
          ? "Nothing pushes the work, so it stays in a worktree on the machine and nobody can reach it. Add a Push step."
          : "Push runs before the last step that changes files, so what it sends is not the finished work.",
    });
  }

  const guardsTheTree = (key: string) => kindOf(key) === "protected-paths";
  const unguarded = sequence.some(
    (key, i) =>
      EXECUTES_THE_TREE.has(kindOf(key) ?? "") &&
      writesAt.some(
        (writeAt) =>
          writeAt < i && !sequence.some((k, j) => guardsTheTree(k) && j > writeAt && j < i)
      )
  );
  if (unguarded) {
    problems.push({
      severity: "broken",
      message:
        "A gate runs the project's own build or test script over a change that Protected files has not read, so a script the agent wrote would execute before anything checked whether it was allowed to write it. Put a Protected files gate after every step that writes and before this one.",
    });
  }

  if (mergeAt !== -1 && mergeAt < sequence.length - 1) {
    problems.push({
      severity: "broken",
      message: `Merge is not last: ${sequence
        .slice(mergeAt + 1)
        .map((key) => lookup(key)?.name ?? key)
        .join(", ")} runs after the change has already landed, so nothing there can stop it. Move Merge to the end.`,
    });
  }

  return problems;
}

export function isRunnable(composition: AgentComposition): boolean {
  return sequenceOf(composition).length > 0;
}

export function brokenProblems(composition: AgentComposition, lookup: Lookup): Problem[] {
  return agentProblems(composition, lookup).filter((p) => p.severity === "broken");
}
