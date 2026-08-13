"use client";

import { useSyncExternalStore } from "react";
import {
  Agent,
  Block,
  Composition,
  DEFAULT_GATES,
  DEFAULT_STEPS,
  SEEDED_AGENTS,
} from "./catalog";

// TODO(BP-331): localStorage stands in for the API so the whole flow is walkable before the
// backend exists. Everything here is replaced by fetches, not extended.
const KEY = "bp-agents-preview";
const EVENT = "bp-agents-preview-change";

export interface RunRecord {
  id: string;
  taskKey: string;
  agentName: string;
  outcome: string;
  failed: boolean;
  minutes: number;
  costUsd: number;
}

export interface StoreShape {
  agents: Agent[];
  gates: Block[];
  steps: Block[];
  /** projectId → agent id */
  projectDefaults: Record<string, string>;
  /** taskKey → agent id */
  taskAgents: Record<string, string>;
  runs: RunRecord[];
}

const EMPTY: StoreShape = {
  agents: [],
  gates: [],
  steps: [],
  projectDefaults: {},
  taskAgents: {},
  runs: [
    { id: "r1", taskKey: "TP-12", agentName: "Default", outcome: "Pull request open", failed: false, minutes: 18, costUsd: 0.74 },
    { id: "r2", taskKey: "TP-11", agentName: "Default", outcome: "Refused: Size", failed: true, minutes: 9, costUsd: 0.31 },
  ],
};

let cache: StoreShape = EMPTY;
let cacheRaw: string | null = null;

function read(): StoreShape {
  if (typeof window === "undefined") return EMPTY;
  const raw = window.localStorage.getItem(KEY);
  if (raw === cacheRaw) return cache;
  cacheRaw = raw;
  if (!raw) {
    cache = EMPTY;
    return cache;
  }
  try {
    cache = { ...EMPTY, ...(JSON.parse(raw) as Partial<StoreShape>) };
  } catch {
    cache = EMPTY;
  }
  return cache;
}

function write(next: StoreShape) {
  window.localStorage.setItem(KEY, JSON.stringify(next));
  window.dispatchEvent(new Event(EVENT));
}

function subscribe(cb: () => void) {
  window.addEventListener(EVENT, cb);
  window.addEventListener("storage", cb);
  return () => {
    window.removeEventListener(EVENT, cb);
    window.removeEventListener("storage", cb);
  };
}

export function useStore() {
  const state = useSyncExternalStore(subscribe, read, () => EMPTY);

  const update = (patch: (prev: StoreShape) => StoreShape) => write(patch(read()));

  // A stored copy of a seeded agent replaces it in place rather than sitting beside it: two rows
  // with one id made every lookup return the shipped version and hid the edit.
  const allAgents = [
    ...SEEDED_AGENTS.map((seed) => state.agents.find((a) => a.id === seed.id) ?? seed),
    ...state.agents.filter((a) => !SEEDED_AGENTS.some((s) => s.id === a.id)),
  ];

  return {
    ...state,
    allAgents,
    allGates: [...DEFAULT_GATES, ...state.gates],
    allSteps: [...DEFAULT_STEPS, ...state.steps],

    addAgent: (agent: Agent) => update((s) => ({ ...s, agents: [...s.agents, agent] })),
    addGate: (gate: Block) => update((s) => ({ ...s, gates: [...s.gates, gate] })),
    addStep: (step: Block) => update((s) => ({ ...s, steps: [...s.steps, step] })),

    saveComposition: (agentId: string, composition: Composition) =>
      update((s) => {
        const seeded = SEEDED_AGENTS.find((a) => a.id === agentId);
        const owned = s.agents.find((a) => a.id === agentId);
        if (owned) {
          return {
            ...s,
            agents: s.agents.map((a) => (a.id === agentId ? { ...a, composition } : a)),
          };
        }
        // Editing a seeded agent stores an override under the same id and keeps its scope, so it
        // stays where the user found it instead of moving to another section
        if (seeded) {
          return { ...s, agents: [...s.agents, { ...seeded, composition }] };
        }
        return s;
      }),

    setProjectDefault: (projectId: string, agentId: string) =>
      update((s) => ({ ...s, projectDefaults: { ...s.projectDefaults, [projectId]: agentId } })),

    setTaskAgent: (taskKey: string, agentId: string) =>
      update((s) => ({ ...s, taskAgents: { ...s.taskAgents, [taskKey]: agentId } })),

    reset: () => write(EMPTY),
  };
}

export function blockLookup(gates: Block[], steps: Block[]) {
  const all = [...steps, ...gates];
  return (key: string) => all.find((b) => b.key === key);
}
