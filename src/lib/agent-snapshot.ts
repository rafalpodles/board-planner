import { Agent } from "@/models/agent";
import { AgentBlock } from "@/models/agentBlock";
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
 * The task's own agent, and nothing else. Choosing one is how a task is handed to a machine, so a
 * task naming none is a task a person is doing — the claim skips it rather than resolving a default
 * on its behalf. Before BP-358 this fell through the project default to the seeded "Default", which
 * is what made an empty field mean "whatever the project says" instead of "nobody".
 *
 * `machineOwnerId` is the person the claiming machine belongs to, and it is required rather than
 * optional: this is the last check before a composition runs, and a caller that forgot to say whose
 * machine it is asking for would silently opt out of it.
 */
export async function snapshotFor(
  projectId: string,
  taskAgentId: unknown,
  machineOwnerId: string | null
): Promise<AgentSnapshot | null> {
  const agentId = taskAgentId ? String(taskAgentId) : "";
  if (!agentId) return null;

  const agent = await Agent.findById(agentId).lean();
  if (!agent) return null;

  // A project agent must not run on another project's task, whichever way it was chosen
  if (agent.scope === "project" && String(agent.project) !== String(projectId)) return null;

  // The same question one layer down, asked where the work is actually picked up rather than where
  // it was written. Every writer of `agent` judges this pairing, and three consecutive rounds of
  // BP-358 each closed one writer and were followed by another of the same shape — a rule spread
  // across every writer is a rule each new path through them can miss. Here it holds for a document
  // however it reached the database, including ones written before those writers were fixed.
  if (agent.scope === "user") {
    const composer = agent.owner ? String(agent.owner) : "";
    const machine = machineOwnerId ? String(machineOwnerId) : "";
    // Presence on both sides, not just equality: "" === "" would read an ownerless agent and an
    // ownerless machine as the same person.
    if (!composer || composer !== machine) {
      // The only record that this happened. The route's own line below it says the agent resolved
      // to nothing runnable, which for this refusal is untrue and would send a reader hunting
      // through a perfectly good agent.
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
