import { isValidObjectId } from "mongoose";
import { parseOptions } from "@/lib/custom-fields";
import {
  CATEGORY_NAME_MAX_LENGTH,
  hasControlCharacters,
  MAX_CATEGORIES,
} from "@/lib/identifiers";
import {
  columnLabelOrRefusal,
  freeColumnId,
  LOAD_BEARING_ROLES,
  MAX_COLUMNS,
} from "@/lib/columns";
import {
  COLUMN_ROLES,
  ColumnRole,
  GRANT_RELATIONS,
  GrantRelation,
  ICustomFieldOption,
  PROJECT_ICONS,
  ROLE_LABELS,
} from "@/types";

export const MAX_SETUP_PEOPLE = 200;
const MAX_REPOSITORY_URL_LENGTH = 2048;

export interface SetupColumn {
  id: string;
  label: string;
  color: string;
  role: ColumnRole;
  order: number;
  triggersPmReview: boolean;
}

export interface ProjectSetup {
  icon?: string;
  columns?: SetupColumn[];
  categories?: { name: string; color: string }[];
  components?: ICustomFieldOption[];
  labels?: ICustomFieldOption[];
  repositoryUrl?: string;
  pmEnabled?: boolean;
  access: { userId: string; relation: GrantRelation }[];
}

export type ParsedSetup = { ok: true; value: ProjectSetup } | { ok: false; error: string };

const fail = (error: string): ParsedSetup => ({ ok: false, error });
const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

function parseColumns(raw: unknown): { columns: SetupColumn[] } | { error: string } {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_COLUMNS) {
    return { error: `columns must be an array of 1-${MAX_COLUMNS} entries` };
  }
  const taken: string[] = [];
  const columns: SetupColumn[] = [];
  let flagged = false;

  for (const [index, entry] of raw.entries()) {
    if (!isRecord(entry)) return { error: "columns entries must be objects" };
    const label = columnLabelOrRefusal(entry.label);
    if ("error" in label) return { error: label.error };
    if (!COLUMN_ROLES.includes(entry.role as ColumnRole)) {
      return { error: `Column role must be one of: ${COLUMN_ROLES.join(", ")}` };
    }
    const role = entry.role as ColumnRole;
    const id = freeColumnId(label.label, taken);
    if (!id) return { error: `Column label "${label.label}" produces an empty id` };
    taken.push(id);

    // One column hands over to the PM, and only a review column can
    const triggersPmReview = entry.triggersPmReview === true && role === "review" && !flagged;
    if (triggersPmReview) flagged = true;

    columns.push({
      id,
      label: label.label,
      color: typeof entry.color === "string" && entry.color ? entry.color : "#6b7280",
      role,
      order: index,
      triggersPmReview,
    });
  }

  // A board that never had these has nothing to lose, so unlike the columns editor this is a state
  // check: nobody is repairing a project that does not exist yet
  for (const [role, loses] of Object.entries(LOAD_BEARING_ROLES) as [ColumnRole, string][]) {
    if (!columns.some((c) => c.role === role)) {
      const { label } = ROLE_LABELS[role];
      return { error: `A board needs a column meaning ${label}. Without one, ${loses}.` };
    }
  }
  return { columns };
}

function parseCategories(raw: unknown): { categories: { name: string; color: string }[] } | { error: string } {
  if (!Array.isArray(raw) || raw.length > MAX_CATEGORIES) {
    return { error: `categories must be an array of at most ${MAX_CATEGORIES} entries` };
  }
  const seen = new Set<string>();
  const categories: { name: string; color: string }[] = [];
  for (const entry of raw) {
    if (!isRecord(entry) || typeof entry.name !== "string") {
      return { error: "Every category needs a name" };
    }
    const name = entry.name.trim();
    if (!name || name.length > CATEGORY_NAME_MAX_LENGTH) {
      return { error: `Category name is required (max ${CATEGORY_NAME_MAX_LENGTH} chars)` };
    }
    if (hasControlCharacters(name)) {
      return { error: "Category name cannot contain control characters" };
    }
    if (seen.has(name.toLowerCase())) return { error: `Category "${name}" is listed twice` };
    seen.add(name.toLowerCase());
    categories.push({
      name,
      color: typeof entry.color === "string" && entry.color ? entry.color : "#3b82f6",
    });
  }
  return { categories };
}

function parseNamedOptions(raw: unknown, what: string): { options: ICustomFieldOption[] } | { error: string } {
  if (!Array.isArray(raw)) return { error: `${what} must be an array` };
  const shaped: ({ value: string; color?: string } | string)[] = [];
  for (const entry of raw) {
    if (typeof entry === "string") {
      shaped.push(entry);
    } else if (isRecord(entry) && typeof entry.name === "string") {
      shaped.push({ value: entry.name, color: typeof entry.color === "string" ? entry.color : undefined });
    } else {
      return { error: `Every entry in ${what} needs a name` };
    }
  }
  const parsed = parseOptions(shaped);
  return parsed.error || !parsed.options ? { error: parsed.error ?? `${what} could not be read` } : { options: parsed.options };
}

function parseAccess(raw: unknown): { access: ProjectSetup["access"] } | { error: string } {
  if (!Array.isArray(raw) || raw.length > MAX_SETUP_PEOPLE) {
    return { error: `access must be an array of at most ${MAX_SETUP_PEOPLE} people` };
  }
  const seen = new Set<string>();
  const access: ProjectSetup["access"] = [];
  for (const entry of raw) {
    if (!isRecord(entry) || typeof entry.userId !== "string" || !isValidObjectId(entry.userId)) {
      return { error: "Every person needs a userId" };
    }
    if (!GRANT_RELATIONS.includes(entry.relation as GrantRelation)) {
      return { error: "A person's access must be owner or member" };
    }
    const userId = entry.userId.toLowerCase();
    if (seen.has(userId)) return { error: "A person is listed twice" };
    seen.add(userId);
    access.push({ userId, relation: entry.relation as GrantRelation });
  }
  return { access };
}

/**
 * What a new project may be created with beyond its name and key. Each field is judged by the rule
 * of the settings screen that edits it later, so a project made here is one those screens could
 * have produced; nothing is written until every field has passed.
 */
export function parseProjectSetup(body: Record<string, unknown>): ParsedSetup {
  const value: ProjectSetup = { access: [] };

  if (body.icon !== undefined) {
    if (typeof body.icon !== "string" || (body.icon !== "" && !PROJECT_ICONS.includes(body.icon))) {
      return fail("icon must be empty or one of the supported project icons");
    }
    value.icon = body.icon;
  }

  if (body.columns !== undefined) {
    const parsed = parseColumns(body.columns);
    if ("error" in parsed) return fail(parsed.error);
    value.columns = parsed.columns;
  }

  if (body.categories !== undefined) {
    const parsed = parseCategories(body.categories);
    if ("error" in parsed) return fail(parsed.error);
    value.categories = parsed.categories;
  }

  for (const key of ["components", "labels"] as const) {
    if (body[key] === undefined) continue;
    const parsed = parseNamedOptions(body[key], key);
    if ("error" in parsed) return fail(parsed.error);
    value[key] = parsed.options;
  }

  if (body.repositoryUrl !== undefined) {
    if (typeof body.repositoryUrl !== "string") return fail("repositoryUrl must be a string");
    const url = body.repositoryUrl.trim();
    if (url.length > MAX_REPOSITORY_URL_LENGTH || hasControlCharacters(url)) {
      return fail("repositoryUrl is not a valid address");
    }
    value.repositoryUrl = url;
  }

  if (body.pm !== undefined) {
    if (!isRecord(body.pm) || (body.pm.enabled !== undefined && typeof body.pm.enabled !== "boolean")) {
      return fail("pm.enabled must be true or false");
    }
    if (body.pm.enabled !== undefined) value.pmEnabled = body.pm.enabled;
  }

  if (body.access !== undefined) {
    const parsed = parseAccess(body.access);
    if ("error" in parsed) return fail(parsed.error);
    value.access = parsed.access;
  }

  return { ok: true, value };
}
