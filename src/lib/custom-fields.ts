import {
  DEFAULT_OPTION_COLOR,
  ICustomField,
  ICustomFieldOption,
  OPTION_FIELD_TYPES,
} from "@/types";

type LegacyOption = string | Partial<ICustomFieldOption>;

/**
 * A field defined before CP-211 carries plain strings. Its option `id` becomes that
 * same string, so every value already stored on a task stays valid and no task data
 * has to be rewritten. Renaming later moves `value` and leaves `id` alone.
 */
export function normalizeOptions(options: LegacyOption[] | undefined): ICustomFieldOption[] {
  return (options || []).map((option, index) => {
    if (typeof option === "string") {
      return { id: option, value: option, color: DEFAULT_OPTION_COLOR, order: index };
    }
    const value = option.value ?? option.id ?? "";
    return {
      id: option.id ?? value,
      value,
      color: option.color || DEFAULT_OPTION_COLOR,
      order: option.order ?? index,
    };
  });
}

type LegacyField = Partial<ICustomField> & {
  fieldType: ICustomField["fieldType"];
  options?: LegacyOption[];
};

export function normalizeField(field: LegacyField, index = 0): ICustomField {
  return {
    ...field,
    options: normalizeOptions(field.options),
    required: field.required ?? false,
    order: field.order ?? index,
    showOnCard: field.showOnCard ?? false,
    showInList: field.showInList ?? false,
    filterable: field.filterable ?? false,
    archived: field.archived ?? false,
  } as ICustomField;
}

export function normalizeFields(fields: unknown[] | undefined): ICustomField[] {
  return (fields || []).map((field, index) => normalizeField(field as LegacyField, index));
}

// Generic over the field shape: the same ordering serves the Mongoose documents and
// the API objects, which differ only in the type of `_id`
type Orderable = { order?: number; archived?: boolean };

/** Form order, with archived fields last so they cannot bury a live one */
export function sortedFields<T extends Orderable>(definitions: T[]): T[] {
  return [...definitions].sort((a, b) => {
    if (!!a.archived !== !!b.archived) return a.archived ? 1 : -1;
    return (a.order ?? 0) - (b.order ?? 0);
  });
}

export function activeFields<T extends Orderable>(definitions: T[]): T[] {
  return definitions.filter((f) => !f.archived);
}

export function isOptionField(field: { fieldType: ICustomField["fieldType"] }): boolean {
  return OPTION_FIELD_TYPES.includes(field.fieldType);
}

function optionIds(field: ICustomField): Set<string> {
  return new Set(normalizeOptions(field.options).map((o) => o.id));
}

export function validateCustomFieldValues(
  values: Record<string, unknown>,
  definitions: ICustomField[]
): { valid: boolean; error?: string } {
  const fieldMap = new Map(definitions.map((f) => [f._id.toString(), f]));

  for (const [key, val] of Object.entries(values)) {
    const field = fieldMap.get(key);
    if (!field) {
      return { valid: false, error: `Unknown custom field: ${key}` };
    }

    // An archived field's values are history: kept, and no longer policed
    if (field.archived) continue;
    if (val === null || val === undefined || val === "") continue;

    switch (field.fieldType) {
      case "number":
        if (typeof val !== "number" || isNaN(val)) {
          return { valid: false, error: `${field.name} must be a number` };
        }
        break;
      case "checkbox":
        if (typeof val !== "boolean") {
          return { valid: false, error: `${field.name} must be a boolean` };
        }
        break;
      case "dropdown": {
        const ids = optionIds(field);
        if (typeof val !== "string" || !ids.has(val)) {
          return { valid: false, error: `${field.name} must be one of its options` };
        }
        break;
      }
      case "multiselect": {
        const ids = optionIds(field);
        if (!Array.isArray(val) || val.some((v) => typeof v !== "string" || !ids.has(v))) {
          return { valid: false, error: `${field.name} must be a list of its options` };
        }
        break;
      }
      case "text":
      case "date":
        if (typeof val !== "string") {
          return { valid: false, error: `${field.name} must be a string` };
        }
        if (val.length > 5000) {
          return { valid: false, error: `${field.name} is too long` };
        }
        break;
    }
  }

  for (const def of definitions) {
    // Archiving beats required: a field nobody can fill must not block every save
    if (!def.required || def.archived) continue;
    const val = values[def._id.toString()];
    const empty =
      val === undefined || val === null || val === "" || (Array.isArray(val) && val.length === 0);
    if (empty) {
      return { valid: false, error: `${def.name} is required` };
    }
  }

  return { valid: true };
}

/**
 * Strip values whose field no longer exists. Archived fields are kept on purpose —
 * before CP-211, removing a definition silently wiped that value from every task on
 * its next save, which is the loss archiving exists to prevent.
 */
export function sanitizeCustomFieldValues(
  values: Record<string, unknown>,
  definitions: ICustomField[]
): Record<string, unknown> {
  const validIds = new Set(definitions.map((f) => f._id.toString()));
  const result: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(values)) {
    if (validIds.has(key)) {
      result[key] = val;
    }
  }
  return result;
}

/** Options in their configured order; dropdown and multiselect both render from this */
export function orderedOptions(field: { options?: LegacyOption[] }): ICustomFieldOption[] {
  return normalizeOptions(field.options).sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
}
