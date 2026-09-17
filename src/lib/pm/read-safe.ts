import type { McpToolDef } from "./mcp-client";

const READ_SAFE_NAME_RE = /^(search|list|get|read|fetch|query|describe|find)/i;
/**
 * Verbs that make a read-prefixed name a mutation. Matched as whole **tokens**, not substrings:
 * as a substring this rejected `get_settings` ("set"), `list_presets` ("reset"),
 * `list_closed_issues` ("close") and `get_merged_pull_requests` ("merge") — all reads, and all
 * with no way for an admin to get them back, because `toolAllowlist` only narrows. Token equality
 * keeps `find_and_merge_duplicates` caught while letting `get_merged_pull_requests` through.
 *
 * `run`, `grant`, `commit`, `push`, `import`, `deploy`, `sync` and `restore` are deliberately absent.
 * Each is a real read's noun as often as a verb (`get_run_status`, `get_grant`, `get_commit`,
 * `list_push_rules`, `get_import_status`, `list_deploy_keys`, `get_sync_status`,
 * `list_restore_points`). Leaving them out means a read-prefixed name that uses one as a verb —
 * `fetch_and_sync_repo` — still passes; the read prefix only turns away names that start with the
 * mutation, like `push_files`. A server that marks such a tool `readOnlyHint: false` still vetoes it.
 */
const WRITE_VERBS = new Set([
  "create", "update", "delete", "write", "append", "replace", "insert", "remove", "set", "patch",
  "post", "send", "move", "archive", "upload", "edit", "destroy", "drop", "purge", "clear",
  "reset", "rename", "assign", "close", "merge", "approve", "revoke", "execute", "invoke", "trigger",
  // BP-476: each of these passed as a read inside a read-prefixed name (`get_or_add_label`)
  "add", "save", "publish", "cancel", "disable", "enable", "upsert", "submit",
]);

/** `getWorkflowRun` and `get_workflow-run` are the same name to anyone reading it */
function tokensOf(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((t) => t.toLowerCase());
}

/**
 * Whether this tool may be exposed on a project that has not enabled writes.
 *
 * `readOnlyHint` is supplied by the **remote server**, and this used to return it verbatim — so a
 * server that annotated a mutating tool `readOnlyHint: true` was exposed on a project whose admin
 * had set `allowWrites: false`, and its calls never counted against the per-turn write cap. The
 * hint can now only make a tool *more* restricted, never less: the name decides, and a server may
 * veto its own tool by saying `false`.
 */
export function isReadSafe(tool: McpToolDef): boolean {
  const tokens = tokensOf(tool.name);
  const nameLooksReadOnly =
    READ_SAFE_NAME_RE.test(tool.name) && !tokens.some((t) => WRITE_VERBS.has(t));
  return nameLooksReadOnly && tool.annotations?.readOnlyHint !== false;
}
