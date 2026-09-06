import { describe, it, expect } from "vitest";
import { isReadSafe } from "./mcp-tools";

const tool = (name: string, readOnlyHint?: boolean) =>
  ({ name, annotations: readOnlyHint === undefined ? undefined : { readOnlyHint } }) as never;

describe("isReadSafe", () => {
  it("does not let a server declare its own mutating tool read-only", () => {
    expect(isReadSafe(tool("create_ticket", true))).toBe(false);
    expect(isReadSafe(tool("delete_everything", true))).toBe(false);
    expect(isReadSafe(tool("get_and_delete_report", true))).toBe(false);
  });

  it("lets a server veto its own read-only tool", () => {
    expect(isReadSafe(tool("list_tickets", false))).toBe(false);
  });

  it("still exposes an ordinary read tool, hint or no hint", () => {
    expect(isReadSafe(tool("list_tickets", true))).toBe(true);
    expect(isReadSafe(tool("list_tickets"))).toBe(true);
    expect(isReadSafe(tool("search_issues"))).toBe(true);
    expect(isReadSafe(tool("get_document"))).toBe(true);
  });

  it("judges by the name when the server says nothing", () => {
    expect(isReadSafe(tool("create_ticket"))).toBe(false);
    expect(isReadSafe(tool("do_something"))).toBe(false);
  });

  it("knows the verbs it had to learn once the hint could no longer override it", () => {
    for (const name of [
      "search_and_destroy",
      "get_then_purge_cache",
      "list_and_reset_counters",
      "find_and_merge_duplicates",
      "read_and_execute_script",
      "query_then_revoke_tokens",
    ]) {
      expect(isReadSafe(tool(name, true)), name).toBe(false);
    }
  });

  it("does not refuse a read whose name merely contains a write verb", () => {
    for (const name of [
      "get_settings",          // "set"
      "list_datasets",         // "set"
      "get_offset",            // "set"
      "list_presets",          // "reset"
      "list_closed_issues",    // "close"
      "get_merged_pull_requests", // "merge", but the token is "merged"
      "list_assignees",        // "assign", token is "assignees"
      "get_dropdown_options",  // "drop"
      "list_workflow_runs",
      "get_run_status",
      "get_grant",
    ]) {
      expect(isReadSafe(tool(name)), name).toBe(true);
    }
  });

  it("refuses a name that does not start as a read, whatever it contains", () => {
    for (const name of ["run_script", "grant_access", "do_the_thing", "trigger_deploy"]) {
      expect(isReadSafe(tool(name, true)), name).toBe(false);
    }
  });
});
