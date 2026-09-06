import { Agent } from "@/models/agent";
import { AgentBlock } from "@/models/agentBlock";
import { normaliseComposition, sequenceOf } from "./agent-rules";
import { StepCapability } from "@/types";

export interface SnapshotEntry {
  key: string;
  kind: "step" | "gate";
  name: string;
  prompt?: string;
  capability?: StepCapability;
  model?: string;
  fallbackModel?: string;
  deterministic?: boolean;
  gateKind?: string;
  params?: Record<string, string>;
}

export interface AgentSnapshot {
  agentId: string;
  name: string;
  sequence: SnapshotEntry[];
}

export async function snapshotFor(
  projectId: string,
  taskAgentId: unknown,
  machineOwnerId: string | null
): Promise<AgentSnapshot | null> {
  const agentId = taskAgentId ? String(taskAgentId) : "";
  if (!agentId) return null;

  const agent = await Agent.findById(agentId).lean();
  if (!agent) return null;

  if (agent.scope === "project" && String(agent.project) !== String(projectId)) return null;

  if (agent.scope === "user") {
    const composer = agent.owner ? String(agent.owner) : "";
    const machine = machineOwnerId ? String(machineOwnerId) : "";
    if (!composer || composer !== machine) {
      console.error(
        `Claim refused: agent ${agentId} is a personal agent belonging to ${composer || "nobody"}, and this machine belongs to ${machine || "nobody"}`
      );
      return null;
    }
  }

  const composition = normaliseComposition(agent.composition);
  const entries = sequenceOf(composition);
  if (entries.length === 0) return null;

  const blocks = await AgentBlock.find({ key: { $in: entries.map((e) => e.key) } }).lean();
  const byKey = new Map(blocks.map((b) => [b.key, b]));

  const sequence: SnapshotEntry[] = [];
  for (const entry of entries) {
    const key = entry.key;
    const block = byKey.get(key);
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
            params: { ...(block.params ?? {}), ...(entry.params ?? {}) },
          }
    );
  }

  return { agentId: String(agent._id), name: agent.name, sequence };
}
