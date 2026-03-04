import { ICustomField } from "@/types";

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
      case "dropdown":
        if (typeof val !== "string" || !field.options.includes(val)) {
          return {
            valid: false,
            error: `${field.name} must be one of: ${field.options.join(", ")}`,
          };
        }
        break;
      case "text":
      case "date":
        if (typeof val !== "string") {
          return { valid: false, error: `${field.name} must be a string` };
        }
        if (typeof val === "string" && val.length > 5000) {
          return { valid: false, error: `${field.name} is too long` };
        }
        break;
    }
  }

  // Check required fields
  for (const def of definitions) {
    if (!def.required) continue;
    const val = values[def._id.toString()];
    if (val === undefined || val === null || val === "") {
      return { valid: false, error: `${def.name} is required` };
    }
  }

  return { valid: true };
}

/** Strip unknown keys — only keep values for fields that exist */
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
