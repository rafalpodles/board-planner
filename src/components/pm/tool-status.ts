const WHAT: Record<string, string> = {
  list_tasks: "the board",
  get_task: "a task",
  get_project_stats: "project stats",
  get_board_digest: "the board digest",
  list_comments: "comments",
  create_task: "a new task",
  update_task: "a task",
  change_status: "a status change",
  assign_task: "an assignment",
  add_comment: "a comment",
};

const READS = new Set(["list_tasks", "get_task", "get_project_stats", "get_board_digest", "list_comments"]);

export function toolStatus(tool: string, phase: "preparing" | "running"): string {
  if (tool.startsWith("mcp_")) return phase === "running" ? "Calling an external tool…" : "Preparing an external tool call…";
  const what = WHAT[tool];
  if (!what) return phase === "running" ? `Running ${tool}…` : `Preparing ${tool}…`;
  if (READS.has(tool)) return `Reading ${what}…`;
  return phase === "running" ? `Applying ${what}…` : `Preparing ${what}…`;
}
