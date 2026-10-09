import { ApiCustomField, ApiProjectCategory, ApiSavedView, ISavedView, SORT_OPTIONS } from "@/types";
import { FILTER_KEYS, migratePersistedFilters, type FieldFilter } from "./board-filters-state";
import { SAVED_VIEW_NAME_MAX_LENGTH, SAVED_VIEW_TEXT_MAX_LENGTH, hasControlCharacters } from "./identifiers";
import { isSprintScopeShape } from "./sprint-scope";

export interface ViewState {
  filters: Record<string, unknown>;
  search: string;
  sortField: string;
  sortDir: "asc" | "desc";
  viewMode: "board" | "list";
  groupBy: string;
  sprintScope: string;
  hiddenColumns: string[];
}

const MAX_FILTER_BYTES = 20_000;
const SORT_FIELD_MAX_LENGTH = 64;

export function viewNameOrRefusal(raw: unknown): { name: string } | { error: string } {
  const name = typeof raw === "string" ? raw.trim() : "";
  if (!name) return { error: "A view needs a name" };
  if (name.length > SAVED_VIEW_NAME_MAX_LENGTH) {
    return { error: `A view name must be ${SAVED_VIEW_NAME_MAX_LENGTH} characters or less` };
  }
  if (hasControlCharacters(name)) return { error: "A view name cannot contain control characters" };
  return { name };
}

const MAX_PICKS = 100;

type StoredFieldFilter = FieldFilter & { values?: string[]; mode?: "any" | "all" };

/** Each entry rebuilt from its known keys, so nothing but short text reaches the stored document */
function cleanFieldFilters(raw: unknown): Record<string, StoredFieldFilter> {
  const clean: Record<string, StoredFieldFilter> = {};
  if (!raw || typeof raw !== "object") return clean;
  const text = (v: unknown) => (typeof v === "string" && v.length <= SAVED_VIEW_TEXT_MAX_LENGTH ? v : undefined);
  for (const [id, entry] of Object.entries(raw as Record<string, unknown>)) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    const kept: StoredFieldFilter = {};
    for (const key of ["value", "from", "to"] as const) {
      const value = text(e[key]);
      if (value !== undefined) kept[key] = value;
    }
    if (Array.isArray(e.values)) {
      kept.values = e.values.slice(0, MAX_PICKS).filter((v): v is string => text(v) !== undefined);
      kept.mode = e.mode === "all" ? "all" : "any";
    }
    if (Object.keys(kept).length) clean[id] = kept;
  }
  return clean;
}

/**
 * Turns what a client sent into what is stored: the shapes are checked, then the filters, sort,
 * grouping and hidden columns go through the same migration the board applies to its own stored
 * filters, so a view can never hold a filter on a field the project no longer has.
 */
export function parseViewState(
  body: Record<string, unknown>,
  board: { customFields?: ApiCustomField[]; categories?: ApiProjectCategory[] }
): { state: ViewState } | { error: string } {
  const filters = body.filters ?? {};
  if (!filters || typeof filters !== "object" || Array.isArray(filters)) {
    return { error: "filters must be an object" };
  }
  const raw = filters as Record<string, unknown>;
  for (const key of FILTER_KEYS) {
    const value = raw[key];
    if (value !== undefined && (typeof value !== "string" || value.length > SAVED_VIEW_TEXT_MAX_LENGTH)) {
      return { error: `filters.${key} must be text of ${SAVED_VIEW_TEXT_MAX_LENGTH} characters or less` };
    }
  }
  if (JSON.stringify(filters).length > MAX_FILTER_BYTES) return { error: "filters are too large" };

  const search = body.search ?? "";
  if (typeof search !== "string" || search.length > SAVED_VIEW_TEXT_MAX_LENGTH) {
    return { error: `search must be text of ${SAVED_VIEW_TEXT_MAX_LENGTH} characters or less` };
  }

  const sortField = body.sortField ?? "manual";
  if (typeof sortField !== "string" || !sortField || sortField.length > SORT_FIELD_MAX_LENGTH) {
    return { error: "sortField must be a field name" };
  }
  const sortDir = body.sortDir ?? "asc";
  if (sortDir !== "asc" && sortDir !== "desc") return { error: "sortDir must be asc or desc" };
  const viewMode = body.viewMode ?? "board";
  if (viewMode !== "board" && viewMode !== "list") return { error: "viewMode must be board or list" };
  const sprintScope = body.sprintScope ?? "all";
  if (typeof sprintScope !== "string" || !isSprintScopeShape(sprintScope)) {
    return { error: "sprintScope must be all, backlog or a sprint id" };
  }
  if (body.hiddenColumns !== undefined && !Array.isArray(body.hiddenColumns)) {
    return { error: "hiddenColumns must be a list" };
  }

  const state = migratePersistedFilters(
    { filters: raw, sortField, sortDir, hiddenColumns: body.hiddenColumns, groupBy: body.groupBy },
    undefined,
    board.customFields ?? [],
    (board.categories ?? []).map((c) => c.name)
  );

  const liveFields = new Set((board.customFields ?? []).map((f) => f._id));
  const sortKnown = SORT_OPTIONS.some((o) => o.value === state.sortField) || liveFields.has(state.sortField);

  return {
    state: {
      filters: { ...state.filters, fields: cleanFieldFilters(state.filters.fields) } as unknown as Record<string, unknown>,
      search,
      sortField: sortKnown ? state.sortField : "manual",
      sortDir: state.sortDir,
      viewMode,
      groupBy: state.groupBy,
      sprintScope,
      hiddenColumns: state.hiddenColumns,
    },
  };
}

type StoredView = { owner: { toString(): string }; shared: boolean };

export function mayEditView(view: StoredView, userId: string, isAdmin: boolean): boolean {
  if (view.owner.toString() === userId) return true;
  return view.shared && isAdmin;
}

export function mayReadView(view: StoredView, userId: string): boolean {
  return view.shared || view.owner.toString() === userId;
}

export function toApiView(
  view: ISavedView & { _id: { toString(): string } },
  userId: string,
  isAdmin: boolean
): ApiSavedView {
  return {
    _id: view._id.toString(),
    name: view.name,
    shared: view.shared,
    mine: view.owner.toString() === userId,
    canEdit: mayEditView(view, userId, isAdmin),
    filters: view.filters ?? {},
    search: view.search ?? "",
    sortField: view.sortField,
    sortDir: view.sortDir,
    viewMode: view.viewMode,
    groupBy: view.groupBy ?? "",
    sprintScope: view.sprintScope ?? "all",
    hiddenColumns: view.hiddenColumns ?? [],
  };
}
