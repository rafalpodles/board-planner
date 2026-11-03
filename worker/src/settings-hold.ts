import type { HeldAgent } from "./api.js";
import { gateCommandsOf, GateCommands } from "./gates/gate-commands.js";
import type { ClaimedTask } from "./types.js";

type GateSettings = Partial<GateCommands> & { baseBranch?: string; remotes?: string[] };

// A commit that adds the program a command names changes no setting, so no hold outlasts this
const HOLD_MS = 24 * 60 * 60_000;

// Nothing about the next task is different until a person edits one of these, so a run that faulted
// on them says the same for every task of that agent. The repositories and the base branch are here
// because they decide which checkout a `./program` is looked for in.
function fingerprintOf(settings: GateSettings): string {
  return JSON.stringify([settings.baseBranch ?? "", settings.remotes ?? [], gateCommandsOf(settings)]);
}

const NAME_LIMIT = 60;

// The server keeps 500 characters of a check, so what lifts the hold goes before the reason, whose
// length a program path decides
export function describeHold(project: string, hold: StandingHold): string {
  const name = hold.agentName.length > NAME_LIMIT ? `${hold.agentName.slice(0, NAME_LIMIT - 1)}…` : hold.agentName;
  return (
    `${project}: agent "${name}" is held, its tasks left in their column until the project's commands, repositories ` +
    `or base branch change, or the agent's gates do; a day at most, or until this worker restarts — ${hold.reason}`
  );
}

interface Hold {
  fingerprint: string;
  gates: string[];
  agentName: string;
  reason: string;
  since: number;
}

export interface StandingHold {
  agentId: string;
  agentName: string;
  reason: string;
}

export interface SettingsHolds {
  hold(task: ClaimedTask, settings: GateSettings, reason: string): void;
  /** A task of a held agent was handed out, so the server no longer holds it. */
  release(task: ClaimedTask): void;
  /** What the board said it still steps over on this project; it lifts a hold when the agent's gates change. */
  keepOnly(projectId: string, agentIds: string[]): void;
  /** What a claim on this project must step over. Reading it lets go of what the settings have moved past. */
  heldAgents(projectId: string, settings: GateSettings): HeldAgent[];
  standing(projectId: string, settings: GateSettings): StandingHold[];
}

export function createSettingsHolds(log: (message: string) => void, now: () => number = Date.now): SettingsHolds {
  const held = new Map<string, Map<string, Hold>>();

  function current(projectId: string, settings: GateSettings): [string, Hold][] {
    const ofProject = held.get(projectId);
    if (!ofProject) return [];
    const fingerprint = fingerprintOf(settings);
    for (const [agentId, hold] of ofProject) {
      if (hold.fingerprint === fingerprint && now() - hold.since < HOLD_MS) continue;
      ofProject.delete(agentId);
      log(`project ${projectId}: claiming for agent ${agentId} again`);
    }
    return [...ofProject];
  }

  return {
    hold(task, settings, reason) {
      const { agentId, name, sequence } = task.agent;
      if (!agentId) return;
      const gates = sequence.filter((entry) => entry.kind === "gate").map((entry) => entry.gateKind ?? "");
      const ofProject = held.get(task.projectId) ?? new Map<string, Hold>();
      ofProject.set(agentId, { fingerprint: fingerprintOf(settings), gates, agentName: name, reason, since: now() });
      held.set(task.projectId, ofProject);
      log(`holding agent ${agentId} on project ${task.projectId} until its settings change, for a day at most`);
    },

    release(task) {
      if (held.get(task.projectId)?.delete(task.agent.agentId)) {
        log(`project ${task.projectId}: claiming for agent ${task.agent.agentId} again`);
      }
    },

    keepOnly(projectId, agentIds) {
      const ofProject = held.get(projectId);
      for (const agentId of ofProject?.keys() ?? []) {
        if (agentIds.includes(agentId)) continue;
        ofProject?.delete(agentId);
        log(`project ${projectId}: claiming for agent ${agentId} again, since the board no longer holds it`);
      }
    },

    heldAgents(projectId, settings) {
      return current(projectId, settings).map(([agentId, { gates }]) => ({ agentId, gates }));
    },

    standing(projectId, settings) {
      return current(projectId, settings).map(([agentId, { agentName, reason }]) => ({ agentId, agentName, reason }));
    },
  };
}
