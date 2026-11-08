import type { QueryFilter } from "mongoose";
import { AGENT_BUCKETS, IAgentBlock } from "@/types";
import type { ScopedDb } from "@/lib/db-scope";
import { DEFAULT_PROVIDER, isProvider, PROVIDER_IDS, providerCapability, ProviderId } from "./agent-kinds";
import type { SnapshotEntry } from "./agent-snapshot";

/**
 * Which coding CLIs a machine can run is its own report (X-CP-Capabilities), and a task is only
 * claimed by a machine that can run every step and gate of its agent. A machine that names no CLI at
 * all is taken to run Claude Code: one built before BP-987 says nothing about it, and a newer one that
 * found none it can run holds its own claims. One that names any runs Claude Code only if it names
 * that too, so a machine signed in only to Codex is offered only what runs on Codex (BP-1125).
 */
export function canRun(capabilities: readonly string[], provider: ProviderId): boolean {
  if (capabilities.includes(providerCapability(provider))) return true;
  return provider === DEFAULT_PROVIDER && !PROVIDER_IDS.some((named) => capabilities.includes(providerCapability(named)));
}

// The one gate that runs a coding CLI; the others run git and the project's own commands
const REVIEW_GATE = "review";

/** The provider a review gate runs on: Claude Code unless it names another */
export function gateProvider(params: Record<string, string> | undefined): ProviderId {
  const named = params?.provider;
  return isProvider(named) ? named : DEFAULT_PROVIDER;
}

export function providersOf(sequence: readonly SnapshotEntry[]): ProviderId[] {
  const used = new Set<ProviderId>();
  for (const entry of sequence) {
    if (entry.kind === "step") {
      if (!entry.deterministic) used.add(entry.provider && isProvider(entry.provider) ? entry.provider : DEFAULT_PROVIDER);
    } else if (entry.gateKind === REVIEW_GATE) used.add(gateProvider(entry.params));
  }
  return [...used];
}

/** The first provider the sequence needs that these capabilities cannot run, or null */
export function lackedBy(sequence: readonly SnapshotEntry[], capabilities: readonly string[]): ProviderId | null {
  return providersOf(sequence).find((provider) => !canRun(capabilities, provider)) ?? null;
}

/**
 * The agents that name any of these block keys, in either stored shape. `$elemMatch`, not a bare
 * string: the path is a subdocument array, and a bare string there is a CastError that took the
 * whole request down (BP-460) — here, every claim of a machine without Codex.
 */
export function agentsNamingAny(keys: readonly string[]) {
  return {
    $or: AGENT_BUCKETS.flatMap((bucket) =>
      keys.flatMap((key) => [
        { [`composition.${bucket}.key`]: key },
        { [`composition.${bucket}`]: { $elemMatch: { $eq: key } } },
      ])
    ),
  };
}

// Push, Pull request, Merge and the gates other than a review store the schema's default provider too,
// which says nothing: the worker runs those itself. A model step's own and a reviewer count, read as
// providersOf reads them: another provider is itself, and anything else, absent or unknown, Claude Code.
function blocksOn(provider: ProviderId): QueryFilter<IAgentBlock>[] {
  const runsOn = provider === DEFAULT_PROVIDER ? { $nin: PROVIDER_IDS.filter((id) => id !== DEFAULT_PROVIDER) } : provider;
  return [
    { kind: "step", deterministic: { $ne: true }, provider: runsOn },
    { kind: "gate", gateKind: REVIEW_GATE, "params.provider": runsOn },
  ];
}

/**
 * The ids of the agents a machine with these capabilities cannot run, for the claim to step over: a
 * task whose agent is in the list is not offered to it. A list of what is excluded rather than of
 * what is allowed, because it is empty for a machine that can run everything and short for one that
 * cannot, and the common case then costs one query that finds nothing.
 *
 * Only a block's own provider counts. A position in a composition cannot change it: whoever may edit
 * an agent is not whoever may choose what runs on a machine (compositionRefusal, snapshotFor).
 */
export async function agentsBeyond(db: ScopedDb, capabilities: readonly string[]): Promise<string[]> {
  const beyond = PROVIDER_IDS.filter((provider) => !canRun(capabilities, provider));
  if (beyond.length === 0) return [];

  const blocks = await db.AgentBlock.find({ $or: beyond.flatMap(blocksOn) }, "key").lean();
  if (blocks.length === 0) return [];

  const agents = await db.Agent.find(agentsNamingAny(blocks.map((block) => block.key)), "_id").lean();
  return agents.map((agent) => String(agent._id));
}

export interface AgentOutOfReach {
  agent: string;
  /** The coding CLIs it needs that none of the machines can run, or where each lacks a different one, those the first lacks */
  lacks: ProviderId[];
}

/**
 * The agents none of these machines can run, judged as the claim judges one machine (agentsBeyond):
 * an agent is out of reach when every machine lacks a CLI one of its blocks runs on. No machines, no
 * verdict: having none is its own reason.
 */
export async function agentsOutOfReach(db: ScopedDb, machines: readonly (readonly string[])[]): Promise<AgentOutOfReach[]> {
  if (machines.length === 0) return [];
  const beyondEach = machines.map((capabilities) => PROVIDER_IDS.filter((provider) => !canRun(capabilities, provider)));
  const candidates = PROVIDER_IDS.filter((provider) => beyondEach.some((beyond) => beyond.includes(provider)));

  const uses = new Map<string, Set<ProviderId>>();
  for (const provider of candidates) {
    const blocks = await db.AgentBlock.find({ $or: blocksOn(provider) }, "key").lean();
    if (blocks.length === 0) continue;
    const agents = await db.Agent.find(agentsNamingAny(blocks.map((block) => block.key)), "_id").lean();
    for (const agent of agents) {
      const id = String(agent._id);
      uses.set(id, (uses.get(id) ?? new Set()).add(provider));
    }
  }

  const out: AgentOutOfReach[] = [];
  for (const [agent, needs] of uses) {
    if (!beyondEach.every((beyond) => beyond.some((provider) => needs.has(provider)))) continue;
    const nowhere = [...needs].filter((provider) => beyondEach.every((beyond) => beyond.includes(provider)));
    out.push({ agent, lacks: nowhere.length > 0 ? nowhere : beyondEach[0].filter((provider) => needs.has(provider)) });
  }
  return out;
}
