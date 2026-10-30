export const VIEW_META = "boardplanner/view";
export const VIEW_TOOLS = new Set([
  "get_task", "list_tasks", "my_tasks", "search_tasks", "get_project_stats",
  "get_sprint", "list_sprints", "create_task", "update_task", "change_task_status",
]);

export type ViewContext = { tool: string; args: Record<string, unknown>; origin?: string; argsKnown: boolean };
type ViewMeta = { tool?: string; arguments?: Record<string, unknown>; origin?: string };
type Rows = { tasks?: Record<string, unknown>[]; truncated?: unknown };

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

export function hostToolName(name: unknown) {
  if (typeof name !== "string") return undefined;
  const bare = name.split("__").pop()!;
  return VIEW_TOOLS.has(bare) ? bare : undefined;
}

export function toolFromShape(data: unknown): string | undefined {
  if (Array.isArray(data)) return "list_sprints";
  if (!isObject(data)) return undefined;
  if (Array.isArray(data.tasks)) {
    if (isObject(data.sprint)) return "get_sprint";
    if ("truncated" in data) return "search_tasks";
    return (data as Rows).tasks!.some((row) => isObject(row) && "statusRole" in row) ? "my_tasks" : "list_tasks";
  }
  if (typeof data.total === "number" && isObject(data.statusBreakdown)) return "get_project_stats";
  if (typeof data.title !== "string") return undefined;
  if (typeof data.key === "string" && typeof data.url === "string" && !("_id" in data)) return "update_task";
  if (typeof data.taskNumber === "number" || typeof data.key === "string") return "get_task";
  return undefined;
}

/** Hosts are not required to forward a result's _meta, so fall back to the host's tool info and arguments, then to the payload. */
export function viewContext(meta: unknown, hostTool: unknown, hostArgs: Record<string, unknown> | undefined, data: unknown): ViewContext | undefined {
  const sent = meta as ViewMeta | undefined;
  if (sent?.tool) return { tool: sent.tool, args: sent.arguments ?? {}, origin: sent.origin, argsKnown: true };
  const named = hostToolName(hostTool);
  const tool = named ?? toolFromShape(data);
  return tool ? { tool, args: hostArgs ?? {}, argsKnown: !!named && !!hostArgs } : undefined;
}
