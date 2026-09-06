import type { McpToolDef } from "./mcp-client";

const READ_SAFE_NAME_RE = /^(search|list|get|read|fetch|query|describe|find)/i;
const WRITE_VERBS = new Set([
  "create", "update", "delete", "write", "append", "replace", "insert", "remove", "set", "patch",
  "post", "send", "move", "archive", "upload", "edit", "destroy", "drop", "purge", "clear",
  "reset", "rename", "assign", "close", "merge", "approve", "revoke", "execute", "invoke", "trigger",
]);

function tokensOf(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((t) => t.toLowerCase());
}

export function isReadSafe(tool: McpToolDef): boolean {
  const tokens = tokensOf(tool.name);
  const nameLooksReadOnly =
    READ_SAFE_NAME_RE.test(tool.name) && !tokens.some((t) => WRITE_VERBS.has(t));
  return nameLooksReadOnly && tool.annotations?.readOnlyHint !== false;
}
