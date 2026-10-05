import { z } from "zod";
import { echo } from "@/lib/echo";
import { normalizeOptions } from "@/lib/custom-fields";
import type { ApiCustomField, ApiProjectColumn } from "@/types";
import type { McpProject } from "./planner-client";

export const COLOUR_PARAM = z
  .string()
  .regex(/^#[0-9a-fA-F]{6}$/, "a colour as #rrggbb")
  .optional();

const OBJECT_ID = /^[0-9a-fA-F]{24}$/;

/** The same word the app's screens carry for what these tools leave to a person */
export const ADD_ONLY =
  "This only ever adds: removing or renaming configuration can erase what tasks hold, so that stays in the app.";

/** The board's own owners and admins, as the Board settings screen has it; the route enforces the same */
export function requireOwner(project: McpProject, projectKey: string, what: string): void {
  if (!project.canAdmin) {
    throw new Error(
      `Only a project owner can ${what} on ${echo(projectKey.toUpperCase())}, as in the app. Nothing was changed.`
    );
  }
}

/** The field a reference names: its id, or its name in any case. Archived fields count — they keep their options. */
export function findField(ref: string, fields: ApiCustomField[]): ApiCustomField {
  const wanted = ref.trim();
  const found = OBJECT_ID.test(wanted)
    ? fields.find((f) => String(f._id).toLowerCase() === wanted.toLowerCase())
    : fields.find((f) => f.name.trim().toLowerCase() === wanted.toLowerCase());
  if (!found) {
    throw new Error(
      `No field "${echo(wanted)}" on this board, by name or id. Fields: ${fields.map((f) => f.name).join(", ") || "none"}`
    );
  }
  return found;
}

/** The column a reference names: its id, or its label in any case; a label two columns share is refused with their ids. */
export function findColumn(ref: string, columns: ApiProjectColumn[]): ApiProjectColumn {
  const wanted = ref.trim().toLowerCase();
  const byId = columns.find((c) => c.id.toLowerCase() === wanted);
  if (byId) return byId;
  const labelled = columns.filter((c) => c.label.trim().toLowerCase() === wanted);
  if (labelled.length > 1) {
    throw new Error(
      `${labelled.length} columns are labelled "${echo(ref.trim())}" — pass the id of one: ${labelled.map((c) => c.id).join(", ")}`
    );
  }
  if (!labelled[0]) {
    throw new Error(
      `No column "${echo(ref.trim())}" on this board, by id or label. Columns: ${columns.map((c) => `${c.label} (${c.id})`).join(", ")}`
    );
  }
  return labelled[0];
}

export const optionLines = (options: ApiCustomField["options"] | undefined) =>
  normalizeOptions(options as never)
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
    .map((option) => ({ id: option.id, value: option.value, color: option.color }));

export const fieldSummary = (field: ApiCustomField) => ({
  id: String(field._id),
  name: field.name,
  fieldType: field.fieldType,
  ...(["dropdown", "multiselect"].includes(field.fieldType) ? { options: optionLines(field.options) } : {}),
  required: !!field.required,
  showOnCard: !!field.showOnCard,
  showInList: !!field.showInList,
  filterable: !!field.filterable,
  archived: !!field.archived,
});

export const columnSummary = (column: ApiProjectColumn) => ({
  id: column.id,
  label: column.label,
  role: column.role,
  color: column.color,
  order: column.order,
});
