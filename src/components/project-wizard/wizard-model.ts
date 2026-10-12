import { isValidProjectKey } from "@/lib/identifiers";
import { MAX_COLUMNS, MAX_COLUMN_LABEL, LOAD_BEARING_ROLES } from "@/lib/columns";
import {
  COLUMN_ROLES,
  ColumnRole,
  DEFAULT_PROJECT_CATEGORIES,
  DEFAULT_PROJECT_COLUMNS,
  DEFAULT_PROJECT_ICON,
  GrantRelation,
  ROLE_LABELS,
} from "@/types";

export const STEPS = [
  { id: "basics", title: "Basics", description: "Name it, pick its task key and an icon.", optional: false },
  { id: "workflow", title: "Workflow", description: "Choose the columns tasks move through.", optional: true },
  { id: "fields", title: "Task fields", description: "Categories, components and labels to start with.", optional: true },
  { id: "access", title: "Automation & access", description: "Connect the repository and choose who can use the board.", optional: true },
  { id: "review", title: "Review", description: "Check everything, then create the project.", optional: false },
] as const;

export type StepId = (typeof STEPS)[number]["id"];

export type Preset = "default" | "simple" | "custom";

export interface ColumnDraft {
  label: string;
  role: ColumnRole;
  color: string;
  triggersPmReview: boolean;
}

export interface NamedDraft {
  name: string;
  color: string;
}

export interface Person {
  _id: string;
  username: string;
  fullName: string;
}

export interface WizardState {
  name: string;
  key: string;
  keyTyped: boolean;
  icon: string;
  description: string;
  preset: Preset;
  customColumns: ColumnDraft[];
  categories: { mode: "default" | "empty" | "custom"; items: NamedDraft[] };
  components: { mode: "empty" | "custom"; items: string[] };
  labels: { mode: "empty" | "custom"; items: string[] };
  repositoryUrl: string;
  pmEnabled: boolean;
  people: { person: Person; relation: GrantRelation }[];
}

const column = (label: string, role: ColumnRole, color: string): ColumnDraft => ({
  label,
  role,
  color,
  triggersPmReview: false,
});

export const DEFAULT_COLUMNS: ColumnDraft[] = DEFAULT_PROJECT_COLUMNS.map((c) => ({
  label: c.label,
  role: c.role,
  color: c.color,
  triggersPmReview: c.triggersPmReview,
}));

// Backlog is kept: new tasks from agents and the PM land in the column with that role
export const SIMPLE_COLUMNS: ColumnDraft[] = [
  column("Backlog", "backlog", "#6b7280"),
  column("To Do", "approved", "#3b82f6"),
  column("In Progress", "active", "#f59e0b"),
  column("Done", "done", "#22c55e"),
];

export const NEW_ITEM_COLOR = "#3b82f6";

export function initialState(): WizardState {
  return {
    name: "",
    key: "",
    keyTyped: false,
    icon: DEFAULT_PROJECT_ICON,
    description: "",
    preset: "default",
    customColumns: SIMPLE_COLUMNS.map((c) => ({ ...c })),
    categories: { mode: "default", items: DEFAULT_PROJECT_CATEGORIES.map((c) => ({ name: c.name, color: c.color })) },
    components: { mode: "empty", items: [] },
    labels: { mode: "empty", items: [] },
    repositoryUrl: "",
    pmEnabled: false,
    people: [],
  };
}

export function columnsOf(state: WizardState): ColumnDraft[] {
  if (state.preset === "default") return DEFAULT_COLUMNS;
  if (state.preset === "simple") return SIMPLE_COLUMNS;
  return state.customColumns;
}

/** One row per role a board may use, with the columns that carry it */
export function roleSummary(columns: ColumnDraft[]) {
  return COLUMN_ROLES.filter((role) => role !== "blocked" || columns.some((c) => c.role === role)).map((role) => ({
    role,
    label: ROLE_LABELS[role].label,
    hint: ROLE_LABELS[role].hint,
    columns: columns.filter((c) => c.role === role).map((c) => c.label),
  }));
}

/** What would stop this board being created, in the server's words, or null */
export function workflowProblem(state: WizardState): string | null {
  if (state.preset !== "custom") return null;
  const columns = state.customColumns;
  if (columns.length === 0 || columns.length > MAX_COLUMNS) {
    return `A board has 1-${MAX_COLUMNS} columns`;
  }
  if (columns.some((c) => !c.label.trim() || c.label.trim().length > MAX_COLUMN_LABEL)) {
    return `Column names must be 1-${MAX_COLUMN_LABEL} characters`;
  }
  for (const [role, loses] of Object.entries(LOAD_BEARING_ROLES) as [ColumnRole, string][]) {
    if (!columns.some((c) => c.role === role)) {
      return `A board needs a column meaning ${ROLE_LABELS[role].label}. Without one, ${loses}.`;
    }
  }
  return null;
}

export function basicsProblem(state: WizardState, takenKeys: Iterable<string>): string | null {
  if (!state.name.trim()) return "Give the project a name.";
  const key = state.key.trim().toUpperCase();
  if (!key) return "Pick a key.";
  if (!isValidProjectKey(key)) return "A key starts with a letter and may hold letters, digits, hyphens or underscores.";
  for (const taken of takenKeys) {
    if (taken.toUpperCase() === key) return `${key} is already used by another board.`;
  }
  return null;
}

export interface CreatePayload {
  name: string;
  key: string;
  description: string;
  icon: string;
  columns?: { label: string; role: ColumnRole; color: string; triggersPmReview: boolean }[];
  categories?: NamedDraft[];
  components?: string[];
  labels?: string[];
  repositoryUrl?: string;
  pm?: { enabled: boolean };
  access?: { userId: string; relation: GrantRelation }[];
}

/**
 * Only what differs from what a plain create gives is sent, so a project made by clicking straight
 * through is exactly the project the old form made.
 */
export function buildPayload(state: WizardState): CreatePayload {
  const payload: CreatePayload = {
    name: state.name.trim(),
    key: state.key.trim().toUpperCase(),
    description: state.description.trim(),
    icon: state.icon,
  };
  if (state.preset !== "default") {
    payload.columns = columnsOf(state).map((c) => ({
      label: c.label.trim(),
      role: c.role,
      color: c.color,
      triggersPmReview: c.triggersPmReview,
    }));
  }
  if (state.categories.mode === "empty") payload.categories = [];
  if (state.categories.mode === "custom") payload.categories = state.categories.items;
  if (state.components.mode === "custom" && state.components.items.length > 0) {
    payload.components = state.components.items;
  }
  if (state.labels.mode === "custom" && state.labels.items.length > 0) {
    payload.labels = state.labels.items;
  }
  if (state.repositoryUrl.trim()) payload.repositoryUrl = state.repositoryUrl.trim();
  if (state.pmEnabled) payload.pm = { enabled: true };
  if (state.people.length > 0) {
    payload.access = state.people.map((p) => ({ userId: p.person._id, relation: p.relation }));
  }
  return payload;
}
