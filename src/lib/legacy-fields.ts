import {
  ApiCustomField,
  ApiLabel,
  DEFAULT_OPTION_COLOR,
  DIFFICULTIES,
  ICustomField,
} from "@/types";
import { normalizeOptions } from "./custom-fields";

/**
 * CP-213 turns `component`, `difficulty` and `labels` from columns on the task into
 * ordinary project fields. Seeding reproduces today's behaviour exactly, so the
 * morning after the migration nothing looks different — the three are simply
 * editable now.
 *
 * Reads fall back to the legacy column, so the migration script is an optimisation
 * rather than a prerequisite: an unmigrated database still renders correctly.
 */
export const LEGACY_FIELD_NAMES = {
  component: "Component",
  difficulty: "Difficulty",
  labels: "Labels",
} as const;

export type LegacyFieldKey = keyof typeof LEGACY_FIELD_NAMES;

// Matches --color-difficulty-* in globals.css, so a migrated badge keeps its colour
const DIFFICULTY_COLORS: Record<string, string> = {
  S: "#4ade80",
  M: "#60a5fa",
  L: "#fbbf24",
  XL: "#f87171",
};

type SeedInput = {
  components?: string[];
  labels?: ApiLabel[];
};

/** The three definitions a project should have, in the order they belong in the form */
export function legacyFieldSeeds(project: SeedInput): Omit<ICustomField, "_id">[] {
  return [
    {
      name: LEGACY_FIELD_NAMES.component,
      fieldType: "dropdown",
      options: (project.components || []).map((value, index) => ({
        id: value,
        value,
        color: DEFAULT_OPTION_COLOR,
        order: index,
      })),
      required: false,
      order: 0,
      showOnCard: true,
      showInList: true,
      filterable: true,
      archived: false,
    },
    {
      name: LEGACY_FIELD_NAMES.difficulty,
      // S → XL, not alphabetical: sorting by difficulty has to keep its meaning,
      // which is the reason options carry an order at all
      fieldType: "dropdown",
      options: DIFFICULTIES.map((value, index) => ({
        id: value,
        value,
        color: DIFFICULTY_COLORS[value] || DEFAULT_OPTION_COLOR,
        order: index,
      })),
      required: false,
      order: 1,
      showOnCard: true,
      showInList: true,
      filterable: true,
      archived: false,
    },
    {
      name: LEGACY_FIELD_NAMES.labels,
      fieldType: "multiselect",
      // The option id IS the label's id, so `task.labels` is already a valid value
      // and no task data has to be rewritten
      options: (project.labels || []).map((label, index) => ({
        id: label._id,
        value: label.name,
        color: label.color || DEFAULT_OPTION_COLOR,
        order: index,
      })),
      required: false,
      order: 2,
      showOnCard: true,
      showInList: false,
      filterable: true,
      archived: false,
    },
  ] as Omit<ICustomField, "_id">[];
}

type FieldLike = { _id: unknown; name: string };

export function findLegacyField<T extends FieldLike>(
  fields: T[] | undefined,
  key: LegacyFieldKey
): T | undefined {
  const name = LEGACY_FIELD_NAMES[key].toLowerCase();
  return (fields || []).find((f) => f.name.toLowerCase() === name);
}

/**
 * A task's value for one of the three, taken from the migrated field when it is
 * there and from the legacy column otherwise. Every reader goes through this, so
 * nothing else has to know the value can live in two places.
 */
export function legacyFieldValue(
  task: { component?: string; difficulty?: string; labels?: string[]; customFieldValues?: Record<string, unknown> },
  fields: ApiCustomField[] | undefined,
  key: LegacyFieldKey
): string | string[] | undefined {
  const field = findLegacyField(fields, key);
  const migrated = field ? task.customFieldValues?.[field._id] : undefined;

  if (key === "labels") {
    if (Array.isArray(migrated) && migrated.length) return migrated as string[];
    return task.labels || [];
  }
  if (typeof migrated === "string" && migrated) return migrated;
  return key === "component" ? task.component : task.difficulty;
}

/** The values the migration writes for one task, keyed by the seeded field ids */
export function migratedValuesFor(
  task: { component?: string; difficulty?: string; labels?: string[] },
  fields: ApiCustomField[]
): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  const component = findLegacyField(fields, "component");
  const difficulty = findLegacyField(fields, "difficulty");
  const labels = findLegacyField(fields, "labels");

  if (component && task.component) values[component._id] = task.component;
  if (difficulty && task.difficulty) values[difficulty._id] = task.difficulty;
  if (labels && task.labels?.length) values[labels._id] = task.labels;
  return values;
}

/**
 * An option list that covers every value already in use. A task can carry a
 * component that was deleted from `project.components`; dropping it during the
 * migration would silently clear that task's value.
 */
export function withValuesInUse(
  field: Omit<ICustomField, "_id">,
  valuesInUse: string[]
): Omit<ICustomField, "_id"> {
  const options = normalizeOptions(field.options);
  const known = new Set(options.map((o) => o.id));
  const extra = [...new Set(valuesInUse)]
    .filter((value) => value && !known.has(value))
    .map((value, index) => ({
      id: value,
      value,
      color: DEFAULT_OPTION_COLOR,
      order: options.length + index,
    }));
  return { ...field, options: [...options, ...extra] };
}

/**
 * Whether the migrated field now renders this value, so the hardcoded rendering
 * must stand down. Keyed on the field existing rather than on its switches: if the
 * user turns the badge off, that is a choice, not a reason to bring the old one back.
 */
export function legacyRenderingSuppressed(
  fields: FieldLike[] | undefined,
  key: LegacyFieldKey
): boolean {
  return !!findLegacyField(fields, key);
}

/**
 * Mirrors a migrated field's value back onto its legacy column. CP-213 keeps those
 * columns written for one release so a rollback loses nothing — without this, every
 * edit made through the migrated field would leave the old column stale.
 *
 * Removed by CP-214 together with the columns themselves.
 */
export function dualWriteLegacyColumns(
  customFieldValues: Record<string, unknown>,
  fields: FieldLike[] | undefined
): Partial<{ component: string; difficulty: string; labels: string[] }> {
  const mirrored: Record<string, unknown> = {};

  const component = findLegacyField(fields, "component");
  if (component && String(component._id) in customFieldValues) {
    mirrored.component = String(customFieldValues[String(component._id)] ?? "");
  }
  const difficulty = findLegacyField(fields, "difficulty");
  if (difficulty && String(difficulty._id) in customFieldValues) {
    const value = customFieldValues[String(difficulty._id)];
    // The column is an enum; an option the project renamed would not be valid there
    if (typeof value === "string" && (DIFFICULTIES as string[]).includes(value)) {
      mirrored.difficulty = value;
    }
  }
  const labels = findLegacyField(fields, "labels");
  if (labels && String(labels._id) in customFieldValues) {
    const value = customFieldValues[String(labels._id)];
    mirrored.labels = Array.isArray(value) ? (value as string[]) : [];
  }

  return mirrored;
}
