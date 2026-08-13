import { Agent } from "@/models/agent";
import { AgentBlock } from "@/models/agentBlock";
import {
  AGENT_BUCKETS,
  AgentComposition,
  ApiAgent,
  ApiAgentBlock,
  IAgent,
  IAgentBlock,
  IProject,
  IUser,
} from "@/types";

interface AgentDoc extends Omit<IAgent, "project"> {
  project: (IProject & { _id: unknown }) | null;
}

export function toApiAgent(agent: AgentDoc): ApiAgent {
  const project = agent.project && typeof agent.project === "object" ? agent.project : null;
  return {
    _id: String(agent._id),
    name: agent.name,
    description: agent.description,
    scope: agent.scope,
    projectId: project ? String(project._id) : null,
    projectName: project?.name ?? null,
    composition: normaliseComposition(agent.composition),
    builtIn: agent.builtIn,
  };
}

export function toApiBlock(block: IAgentBlock): ApiAgentBlock {
  return {
    _id: String(block._id),
    key: block.key,
    kind: block.kind,
    name: block.name,
    description: block.description,
    builtIn: block.builtIn,
    gateKind: block.gateKind,
    params: block.params ?? {},
    prompt: block.prompt,
    capability: block.capability,
    model: block.model,
    fallbackModel: block.fallbackModel,
    deterministic: block.deterministic,
  };
}

// A bucket added after some agents were stored comes back undefined, and every consumer indexes by
// bucket. Filling the gap here keeps that from being every caller's problem.
export function normaliseComposition(value: Partial<AgentComposition> | undefined): AgentComposition {
  const out = {} as AgentComposition;
  for (const bucket of AGENT_BUCKETS) out[bucket] = value?.[bucket] ?? [];
  return out;
}

/**
 * Every agent this user may pick: the shipped ones, their own, and those belonging to a project
 * they can reach. A project agent is never offered on another project.
 */
export async function visibleAgents(user: IUser, projectIds: string[]) {
  return Agent.find({
    $or: [
      { scope: "global" },
      { scope: "user", owner: user._id },
      { scope: "project", project: { $in: projectIds } },
    ],
  })
    .populate("project", "name key")
    .sort({ scope: 1, name: 1 })
    .lean();
}

export async function allBlocks() {
  return AgentBlock.find({}).sort({ kind: -1, builtIn: -1, name: 1 }).lean();
}
