import { ApiCustomField, ApiLabel, DEFAULT_OPTION_COLOR, Difficulty, ICustomField } from "@/types";

const DIFFICULTIES: Difficulty[] = ["S", "M", "L", "XL"];
import { normalizeOptions } from "./custom-fields";

export const LEGACY_FIELD_NAMES = {
  component: "Component",
  difficulty: "Difficulty",
  labels: "Labels",
} as const;

export type LegacyFieldKey = keyof typeof LEGACY_FIELD_NAMES;

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

