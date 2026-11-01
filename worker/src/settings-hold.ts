import type { HeldAgent } from "./api.js";
import { gateCommandsOf, GateCommands } from "./gates/gate-commands.js";
import type { ClaimedTask } from "./types.js";

type GateSettings = Partial<GateCommands> & { baseBranch?: string };

// Nothing about the next task is different until a person edits one of these, so a run that faulted
// on them says the same for every task of that agent. The base branch is here because it decides
// which checkout a `./program` is looked for in.
function fingerprintOf(settings: GateSettings): string {
  return JSON.stringify([settings.baseBranch ?? "", gateCommandsOf(settings)]);
}

interface Hold {
  fingerprint: string;
  gates: string[];
}

export interface SettingsHolds {
  hold(task: ClaimedTask, settings: GateSettings): void;
  /** What a claim on this project must step over. Reading it lets go of what the settings have moved past. */
  heldAgents(projectId: string, settings: GateSettings): HeldAgent[];
}

export function createSettingsHolds(log: (message: string) => void): SettingsHolds {
  const held = new Map<string, Map<string, Hold>>();

  return {
    hold(task, settings) {
      const { agentId, sequence } = task.agent;
      if (!agentId) return;
      const gates = sequence.filter((entry) => entry.kind === "gate").map((entry) => entry.gateKind ?? "");
      const ofProject = held.get(task.projectId) ?? new Map<string, Hold>();
      ofProject.set(agentId, { fingerprint: fingerprintOf(settings), gates });
      held.set(task.projectId, ofProject);
      log(`holding agent ${agentId} on project ${task.projectId} until its settings change`);
    },

    heldAgents(projectId, settings) {
      const ofProject = held.get(projectId);
      if (!ofProject) return [];
      const fingerprint = fingerprintOf(settings);
      for (const [agentId, hold] of ofProject) {
        if (hold.fingerprint === fingerprint) continue;
        ofProject.delete(agentId);
        log(`project ${projectId}'s settings changed; claiming for agent ${agentId} again`);
      }
      return [...ofProject].map(([agentId, { gates }]) => ({ agentId, gates }));
    },
  };
}
