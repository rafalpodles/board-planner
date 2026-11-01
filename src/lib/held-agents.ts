import { Types } from "mongoose";
import type { ScopedDb } from "@/lib/db-scope";
import { snapshotFor } from "./agent-snapshot";

/**
 * An agent a machine stopped claiming for after a project's own commands could not run (BP-1117),
 * with the gates it had then. The machine judges the commands and the base branch itself. The gates
 * are judged here, because it never sees the agent without claiming a task, and the fault's own
 * remedy can be to take a gate out of the agent.
 */
export interface HeldAgent {
  agentId: string;
  gates: string[];
}

// Past this an agent is offered as if it were not held: a task a poll, spending no attempt
const MAX_HELD_AGENTS = 50;

export function heldAgentsFrom(value: unknown): HeldAgent[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return null;
  const held: HeldAgent[] = [];
  for (const entry of value) {
    const { agentId, gates } = (entry ?? {}) as Partial<Record<keyof HeldAgent, unknown>>;
    if (typeof agentId !== "string" || !Types.ObjectId.isValid(agentId)) return null;
    if (!Array.isArray(gates) || gates.some((gate) => typeof gate !== "string")) return null;
    held.push({ agentId, gates });
  }
  return held.slice(0, MAX_HELD_AGENTS);
}

const sameGates = (a: string[], b: string[]) => JSON.stringify(a) === JSON.stringify(b);

/** The agents to step over: those whose gates are what the machine saw fail. */
export async function agentsStillHeld(
  db: ScopedDb,
  projectId: string,
  held: HeldAgent[],
  machineOwnerId: string | null
): Promise<string[]> {
  const verdicts = await Promise.all(
    held.map(async ({ agentId, gates }) => {
      const agent = await snapshotFor(db, projectId, agentId, machineOwnerId);
      const current = agent?.sequence.filter((entry) => entry.kind === "gate").map((entry) => entry.gateKind ?? "");
      return current && sameGates(current, gates) ? [agentId] : [];
    })
  );
  return verdicts.flat();
}
