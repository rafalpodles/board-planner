import { DEFAULT_PROJECT_CATEGORIES, DEFAULT_PROJECT_COLUMNS } from "@/types";
import { LEGACY_FIELD_NAMES } from "@/lib/legacy-fields";
import type { ApiSetupGuideStep, MachineState, SetupGuideGroupId, SetupGuideStepId } from "@/types";

export interface SetupGuideFacts {
  hasTasks: boolean;
  /** People with a grant on the board, the owner included */
  grantCount: number;
  columnsCustomised: boolean;
  fieldsCustomised: boolean;
  hasSprint: boolean;
  repositoryUrl: string;
  hasChannel: boolean;
  hasWebhook: boolean;
  /** An MCP client the reader approved, listed under Connected apps */
  mcpConnected: boolean;
  pmEnabled: boolean;
  /** Something to run the PM and AI Assist on: the organisation's own key, the server's, or the managed one */
  aiKeySet: boolean;
  workerEnabled: boolean;
  lockedByInstance: boolean;
  machine: MachineState;
  handedOver: boolean;
  ssoConfigured: boolean;
  paidPlan: boolean;
  readerIsInstanceAdmin: boolean;
  /** The hosted service: a self-hosted instance sets its provider and licence in the environment */
  hosted: boolean;
}

const STEPS: readonly { id: SetupGuideStepId; group: SetupGuideGroupId; instanceAdminOnly?: true; hostedOnly?: true }[] = [
  { id: "tasks", group: "board" },
  { id: "team", group: "board" },
  { id: "columns", group: "board" },
  { id: "fields", group: "board" },
  { id: "sprint", group: "board" },
  { id: "repository", group: "connections" },
  { id: "channel", group: "connections" },
  { id: "webhook", group: "connections" },
  { id: "mcp", group: "connections" },
  { id: "pm", group: "ai", instanceAdminOnly: true },
  { id: "aiKey", group: "ai", instanceAdminOnly: true },
  { id: "runs", group: "agents" },
  { id: "machine", group: "agents" },
  { id: "handover", group: "agents" },
  { id: "sso", group: "organisation", instanceAdminOnly: true, hostedOnly: true },
  { id: "plan", group: "organisation", instanceAdminOnly: true, hostedOnly: true },
];

export function setupGuideSteps(facts: SetupGuideFacts): ApiSetupGuideStep[] {
  const done: Record<SetupGuideStepId, boolean> = {
    tasks: facts.hasTasks,
    team: facts.grantCount > 1,
    columns: facts.columnsCustomised,
    fields: facts.fieldsCustomised,
    sprint: facts.hasSprint,
    repository: facts.repositoryUrl.trim() !== "",
    channel: facts.hasChannel,
    webhook: facts.hasWebhook,
    mcp: facts.mcpConnected,
    pm: facts.pmEnabled,
    aiKey: facts.aiKeySet,
    runs: facts.workerEnabled && !facts.lockedByInstance,
    machine: facts.machine === "live",
    handover: facts.handedOver,
    sso: facts.ssoConfigured,
    plan: facts.paidPlan,
  };
  // With agent runs locked off by an instance admin, nothing after the switch is the owner's to do
  const lockedOut = facts.lockedByInstance && !facts.readerIsInstanceAdmin;
  return STEPS.filter(
    (s) =>
      (!s.instanceAdminOnly || facts.readerIsInstanceAdmin) &&
      (!s.hostedOnly || facts.hosted) &&
      !(lockedOut && (s.id === "machine" || s.id === "handover"))
  ).map(({ id, group }) => ({
    id,
    group,
    done: done[id],
    locked: id === "runs" && lockedOut,
  }));
}

export function setupGuideComplete(steps: ApiSetupGuideStep[]): boolean {
  // A step locked by somebody else is not left for this reader to do
  return steps.every((s) => s.done || s.locked);
}

type Stored = { id?: string; label?: string; role?: string };

export function columnsCustomised(stored: Stored[] | null | undefined): boolean {
  if (!stored || stored.length === 0) return false;
  if (stored.length !== DEFAULT_PROJECT_COLUMNS.length) return true;
  return stored.some((c, i) => {
    const d = DEFAULT_PROJECT_COLUMNS[i];
    return c.id !== d.id || c.label !== d.label || c.role !== d.role;
  });
}

const SEEDED_FIELD_NAMES = new Set(Object.values(LEGACY_FIELD_NAMES).map((n) => n.toLowerCase()));

// A new board is seeded with the legacy fields, so having them says nothing
export function fieldsCustomised(
  customFields: { name?: string }[] | null | undefined,
  categories: { name?: string }[] | null | undefined
): boolean {
  if (customFields?.some((f) => !SEEDED_FIELD_NAMES.has((f.name ?? "").toLowerCase()))) return true;
  if (!categories) return false;
  const names = DEFAULT_PROJECT_CATEGORIES.map((c) => c.name);
  return categories.length !== names.length || categories.some((c, i) => c.name !== names[i]);
}

export const MAX_DISMISSED_SETUP_GUIDES = 200;
