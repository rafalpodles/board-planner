import { Agent } from "@/models/agent";
import { Project } from "@/models/project";
import { AgentBlock } from "@/models/agentBlock";
import { AgentComposition, IAgentBlock } from "@/types";
import { GATE_KINDS } from "./agent-kinds";

// The blocks the worker implements today. Seeding them is what makes the catalog describe the
// machine rather than an intention: a key here has a counterpart in worker/src, and a key without
// one refuses the run.
type SeedBlock = Partial<IAgentBlock> & Pick<IAgentBlock, "key" | "kind" | "name">;

// Derived rather than restated: a kind's name, description and defaults live in agent-kinds, so the
// seeded row and the form that edits it cannot describe the same gate differently.
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

/** The seeded "Default" agent's name. Not a fallback — a project or task still has to choose it. */
export const SEEDED_DEFAULT_NAME = "Default";

/** The one that carries a Merge step; projects that used to merge automatically adopt it. */
export const MERGING_AGENT_NAME = "Merges its own work";

// Exactly today's pipeline. Adopting agents has to be a no-op for a project that never touches one,
// so this is what a project naming no agent of its own runs.
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

// The merge preset's agent. Merging is a property of the composition now, so "may this project
// merge" is answered by whether its agent carries the step — not by a boolean beside it.
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

/** Idempotent: safe to run on every boot, and it never overwrites a description someone edited. */
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

  await adoptTheMergingAgent();
}

/**
 * A project that merged its own work did so through `worker.policy.autoMerge`, and that flag is
 * gone: merging is a Merge step now. Without this, every such project silently falls back to the
 * Default agent, which stops at the pull request — the worker would keep running and quietly stop
 * doing the last thing the project asked of it.
 *
 * Only where no agent has been chosen, so it never overrides a decision somebody has since made,
 * and it matches nothing on the next boot.
 */
async function adoptTheMergingAgent() {
  const merging = await Agent.findOne({ scope: "global", name: MERGING_AGENT_NAME }, "_id").lean();
  if (!merging) return;

  await Project.updateMany(
    { "worker.policy.autoMerge": true, "worker.agent": { $in: [null, undefined] } },
    { $set: { "worker.agent": merging._id } }
  );
}
