import { ICustomField } from "@/types";
import { activeFields, isOptionField, matchOptionValue, orderedOptions } from "./custom-fields";

/** Structural, so the server's ICustomField and the client's ApiCustomField both fit */
type FieldLike = {
  _id: unknown;
  name: string;
  fieldType: ICustomField["fieldType"];
  options?: ICustomField["options"];
  order?: number;
  archived?: boolean;
};

export interface PromptField {
  name: string;
  options: string[];
  /** Several values may apply, so the prompt may offer an array for this one */
  multi: boolean;
}

/**
 * The choice fields a project actually defines, for the prompt to ask about.
 *
 * Nothing here names a field. Asking about `difficulty` and `component` by name meant a
 * project without them still paid for an answer — the prompt fell back to a hardcoded
 * S/M/L/XL scale — while a project that added a third choice field was never asked.
 */
export function choiceFieldsForPrompt(definitions: FieldLike[]): PromptField[] {
  return activeFields(definitions)
    .filter(isOptionField)
    .map((f) => ({
      name: f.name,
      options: orderedOptions(f).map((o) => o.value),
      multi: f.fieldType === "multiselect",
    }))
    .filter((f) => f.options.length > 0);
}

/**
 * The model answers with field names and option text; this turns that into the
 * `customFieldValues` shape a task is stored with.
 *
 * Every miss is dropped rather than thrown: a generated value is a suggestion, and one
 * bad guess must not cost the user the whole generated task.
 */
export function resolveGeneratedFields(
  answers: unknown,
  definitions: FieldLike[]
): Record<string, string | string[]> {
  if (!answers || typeof answers !== "object") return {};

  const byName = new Map(
    activeFields(definitions)
      .filter(isOptionField)
      .map((f) => [f.name.trim().toLowerCase(), f])
  );

  const resolved: Record<string, string | string[]> = {};
  for (const [name, value] of Object.entries(answers as Record<string, unknown>)) {
    const field = byName.get(String(name).trim().toLowerCase());
    if (!field) continue;

    // A multi-choice field stores an array; a bare string there fails validation on save,
    // and the user would see the task they just generated refuse to save
    const chosen = [...new Set(
      (Array.isArray(value) ? value : [value])
        .map((v) => matchOptionValue(field, v))
        .filter((id): id is string => !!id)
    )];
    if (!chosen.length) continue;

    // A single-choice field takes the first value the model offered that the project
    // actually has — dropping the whole answer because it arrived as a list would be the
    // same fault this module exists to remove
    resolved[String(field._id)] =
      field.fieldType === "multiselect" ? chosen : chosen[0];
  }
  return resolved;
}
