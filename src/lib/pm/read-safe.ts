import { McpToolDef } from "./mcp-client";

const READ_SAFE_NAME_RE = /^(search|list|get|read|fetch|query|describe|find)/i;
/**
 * Verbs that make a read-prefixed name a mutation. Matched as whole **tokens**, not substrings:
 * as a substring this rejected `get_settings` ("set"), `list_presets` ("reset"),
 * `list_closed_issues` ("close") and `get_merged_pull_requests` ("merge") — all reads, and all
 * with no way for an admin to get them back, because `toolAllowlist` only narrows. Token equality
 * keeps `find_and_merge_duplicates` caught while letting `get_merged_pull_requests` through.
 *
 * `run` and `grant` are deliberately absent. They are ambiguous even as tokens
 * (`get_run_status`, `get_grant`), and the read-prefix requirement below is what actually stops a
 * mutation being called: `run_script` never starts with a read verb, so it never reaches this list.
 */
const WRITE_VERBS = new Set([
  "create", "update", "delete", "write", "append", "replace", "insert", "remove", "set", "patch",
  "post", "send", "move", "archive", "upload", "edit", "destroy", "drop", "purge", "clear",
  "reset", "rename", "assign", "close", "merge", "approve", "revoke", "execute", "invoke", "trigger",
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
