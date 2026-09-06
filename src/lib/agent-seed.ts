import { Agent } from "@/models/agent";
import { Project } from "@/models/project";
import { AgentBlock } from "@/models/agentBlock";
import { AgentComposition, IAgentBlock } from "@/types";
import { GATE_KINDS } from "./agent-kinds";

type SeedBlock = Partial<IAgentBlock> & Pick<IAgentBlock, "key" | "kind" | "name">;

function gateSeeds(): SeedBlock[] {
  return GATE_KINDS.map((kind) => ({
    key: kind.key,
    kind: "gate" as const,
    name: kind.name,
    description: kind.description,
    gateKind: kind.key,
    params: kind.defaults,
  }));
}

export const BUILT_IN_BLOCKS: SeedBlock[] = [
  {
    key: "implement",
    kind: "step",
    name: "Implement",
    description: "Reads the task, makes the change, writes a test for it.",
    capability: "edit",
    model: "opus",
    fallbackModel: "sonnet",
    prompt:
      "Make the change the task describes, add or update a test covering it, keep the diff minimal.",
  },
  {
    key: "push",
    kind: "step",
    name: "Push",
    description: "Pushes the branch, so a human can reach the work.",
    deterministic: true,
  },
  {
    key: "pull-request",
    kind: "step",
    name: "Pull request",
    description: "Opens the pull request.",
    deterministic: true,
  },
  {
    key: "merge",
    kind: "step",
    name: "Merge",
    description: "Merges the pull request. Leave it out and a human decides.",
    deterministic: true,
  },
  ...gateSeeds(),
];

export const SEEDED_DEFAULT_NAME = "Default";

export const MERGING_AGENT_NAME = "Merges its own work";

export const DEFAULT_COMPOSITION: AgentComposition = {
  analysis: [],
  implementation: [{ key: "implement" }],
  verification: [
    { key: "protected-paths" },
    { key: "diff-size" },
    { key: "test-presence" },
    { key: "build" },
    { key: "test-run" },
    { key: "review" },
  ],
  delivery: [{ key: "push" }, { key: "pull-request" }],
};

export const CAREFUL_COMPOSITION: AgentComposition = {
  analysis: [],
  implementation: [{ key: "implement" }],
  verification: [
    { key: "diff-size" },
    { key: "protected-paths" },
    { key: "test-presence" },
    { key: "build" },
    { key: "test-run" },
    { key: "security-review" },
    { key: "review" },
  ],
  delivery: [{ key: "push" }, { key: "pull-request" }],
};

export const MERGING_COMPOSITION: AgentComposition = {
  analysis: [],
  implementation: [{ key: "implement" }],
  verification: [
    { key: "protected-paths" },
    { key: "diff-size" },
    { key: "test-presence" },
    { key: "build" },
    { key: "test-run" },
    { key: "review" },
  ],
  delivery: [{ key: "push" }, { key: "pull-request" }, { key: "merge" }],
};

export const SECURITY_REVIEW_BLOCK: SeedBlock = {
  key: "security-review",
  kind: "gate",
  name: "Security reviewed",
  description: "A second model reads the change for injection, secrets and authorization.",
  gateKind: "review",
  params: { focus: "security", model: "opus" },
};

export async function seedAgents() {
  for (const block of [...BUILT_IN_BLOCKS, SECURITY_REVIEW_BLOCK]) {
    await AgentBlock.updateOne(
      { key: block.key },
      { $setOnInsert: { ...block, builtIn: true } },
      { upsert: true }
    );
  }

  await Agent.updateOne(
    { scope: "global", name: SEEDED_DEFAULT_NAME },
    {
      $setOnInsert: {
        name: SEEDED_DEFAULT_NAME,
        description: "What a worker does today: writes the change, then every check below.",
        scope: "global",
        composition: DEFAULT_COMPOSITION,
        builtIn: true,
      },
    },
    { upsert: true }
  );

  await Agent.updateOne(
    { scope: "global", name: MERGING_AGENT_NAME },
    {
      $setOnInsert: {
        name: MERGING_AGENT_NAME,
        description:
          "Everything the default does, and merges the pull request once every check has passed.",
        scope: "global",
        composition: MERGING_COMPOSITION,
        builtIn: true,
      },
    },
    { upsert: true }
  );

  await Agent.updateOne(
    { scope: "global", name: "With security review" },
    {
      $setOnInsert: {
        name: "With security review",
        description: "The same, plus a model reading the change for security before delivery.",
        scope: "global",
        composition: CAREFUL_COMPOSITION,
        builtIn: true,
      },
    },
    { upsert: true }
  );

}

/**
 * `adoptTheMergingAgent` stood here: it pointed every project carrying the retired
 * `worker.policy.autoMerge` flag at the Merging agent, wherever `worker.agent` was null.
 *
 * Removed with BP-458, which makes a null default something a project admin can deliberately
 * choose — and the schema defaults that field to null, so a cleared project was indistinguishable
 * from one that never had a default. Left in place it re-adopted the agent on the next boot, and
 * its own comment claimed it "matches nothing on the next boot", which had stopped being true.
 *
 * Safe to drop rather than narrow: since BP-358 `worker.agent` is not a claim-time fallback at
 * all — `snapshotFor` resolves the task's own agent and nothing else — so this only ever moved a
 * suggestion in the picker, never what a worker runs. Projects it already reached keep it.
 */
