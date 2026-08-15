import { Agent } from "@/models/agent";
import { AgentBlock } from "@/models/agentBlock";
import { Project } from "@/models/project";
import { normaliseComposition, sequenceOf } from "./agent-rules";
import { StepCapability } from "@/types";

/**
 * What the worker is handed on a claim: the agent resolved into an ordered list of blocks, whole.
 *
 * A snapshot rather than a reference, for two reasons. The agent can be edited or deleted while a
 * run holds the task, and a run has to mean what it meant when it started. And the worker resolves
 * a block's *behaviour* from its own source by key — the prompt and parameters travel, the tool
 * list never does.
 */
export interface SnapshotEntry {
  key: string;
  kind: "step" | "gate";
  name: string;
  /** step only */
  prompt?: string;
  capability?: StepCapability;
  model?: string;
  fallbackModel?: string;
  deterministic?: boolean;
  /** gate only */
  gateKind?: string;
  params?: Record<string, string>;
}

export interface AgentSnapshot {
  agentId: string;
  name: string;
  sequence: SnapshotEntry[];
}

/**
 * The task's own agent wins; otherwise the project's default. A project with neither has nothing to
 * run, and the claim says so by returning null rather than by inventing a pipeline.
 */
export async function snapshotFor(
  projectId: string,
  taskAgentId?: unknown
): Promise<AgentSnapshot | null> {
  let agentId = taskAgentId ? String(taskAgentId) : "";

  if (!agentId) {
    const project = await Project.findById(projectId, "worker.agent").lean();
    const fallback = (project as { worker?: { agent?: unknown } } | null)?.worker?.agent;
    agentId = fallback ? String(fallback) : "";
  }
  if (!agentId) return null;

  const agent = await Agent.findById(agentId).lean();
  if (!agent) return null;

  // A project agent must not run on another project's task, whichever way it was chosen
  if (agent.scope === "project" && String(agent.project) !== String(projectId)) return null;

  const composition = normaliseComposition(agent.composition);
  const entries = sequenceOf(composition);
  if (entries.length === 0) return null;

  const blocks = await AgentBlock.find({ key: { $in: entries.map((e) => e.key) } }).lean();
  const byKey = new Map(blocks.map((b) => [b.key, b]));

  const sequence: SnapshotEntry[] = [];
  for (const entry of entries) {
    const key = entry.key;
    const block = byKey.get(key);
    // A key with no block is not skipped: skipping would quietly run a shorter agent than the one
    // somebody composed. The worker refuses the run and names the key.
    if (!block) return null;

    sequence.push(
      block.kind === "step"
        ? {
            key: block.key,
            kind: "step",
            name: block.name,
            prompt: block.prompt,
            capability: block.capability,
            model: block.model,
            fallbackModel: block.fallbackModel,
            deterministic: block.deterministic,
          }
        : {
            key: block.key,
            kind: "gate",
            name: block.name,
            gateKind: block.gateKind,
            // The position's own parameters win over the block's: that is what makes two Size
            // gates with different limits possible without two catalog rows.
            params: { ...(block.params ?? {}), ...(entry.params ?? {}) },
          }
    );
  }

  return { agentId: String(agent._id), name: agent.name, sequence };
}
