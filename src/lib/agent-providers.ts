import { AGENT_BUCKETS } from "@/types";
import type { ScopedDb } from "@/lib/db-scope";
import { DEFAULT_PROVIDER, isProvider, PROVIDER_IDS, providerCapability, ProviderId } from "./agent-kinds";
import type { SnapshotEntry } from "./agent-snapshot";

/**
 * Which coding CLIs a machine can run is its own report (X-CP-Capabilities), and a task is only
 * claimed by a machine that can run every step and gate of its agent. Claude Code needs no report:
 * every worker that ever existed runs it, and one built before BP-987 says nothing about it.
 */
export function canRun(capabilities: readonly string[], provider: ProviderId): boolean {
  return provider === DEFAULT_PROVIDER || capabilities.includes(providerCapability(provider));
}

/** The provider a gate runs on: only the review gate names one, and it defaults to Claude Code */
export function gateProvider(params: Record<string, string> | undefined): ProviderId {
  const named = params?.provider;
  return isProvider(named) ? named : DEFAULT_PROVIDER;
}

export function providersOf(sequence: readonly SnapshotEntry[]): ProviderId[] {
  const used = new Set<ProviderId>();
  for (const entry of sequence) {
    if (entry.kind === "step") used.add(entry.provider && isProvider(entry.provider) ? entry.provider : DEFAULT_PROVIDER);
    else used.add(gateProvider(entry.params));
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

  const blocks = await db.AgentBlock.find(
    { $or: beyond.flatMap((provider) => [{ provider }, { "params.provider": provider }]) },
    "key"
  ).lean();
  if (blocks.length === 0) return [];

  const agents = await db.Agent.find(agentsNamingAny(blocks.map((block) => block.key)), "_id").lean();
  return agents.map((agent) => String(agent._id));
}
