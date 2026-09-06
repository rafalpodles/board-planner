import { ICustomField } from "@/types";
import { activeFields, isOptionField, matchOptionValue, orderedOptions } from "./custom-fields";

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
  multi: boolean;
}

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

    const chosen = [...new Set(
      (Array.isArray(value) ? value : [value])
        .map((v) => matchOptionValue(field, v))
        .filter((id): id is string => !!id)
    )];
    if (!chosen.length) continue;

    resolved[String(field._id)] =
      field.fieldType === "multiselect" ? chosen : chosen[0];
  }
  return resolved;
}
