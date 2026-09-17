import { describe, it, expect } from "vitest";
import { isReadSafe } from "./mcp-tools";

/**
 * BP-321, finding 2. `readOnlyHint` is supplied by the **remote server**, and this used to return
 * it verbatim — so a server that annotated a mutating tool `readOnlyHint: true` was exposed on a
 * project whose admin had set `allowWrites: false` (`mcp-tools.ts`: `if (!readSafe &&
 * !server.allowWrites) continue`), and its calls never counted against the per-turn write cap.
 */
const tool = (name: string, readOnlyHint?: boolean) =>
  ({ name, annotations: readOnlyHint === undefined ? undefined : { readOnlyHint } }) as never;

describe("isReadSafe", () => {
  it("does not let a server declare its own mutating tool read-only", () => {
    expect(isReadSafe(tool("create_ticket", true))).toBe(false);
    expect(isReadSafe(tool("delete_everything", true))).toBe(false);
    // A read-shaped name with a write verb in it, which is the shape the gate is really guarding
    expect(isReadSafe(tool("get_and_delete_report", true))).toBe(false);
  });

  it("lets a server veto its own read-only tool", () => {
    expect(isReadSafe(tool("list_tickets", false))).toBe(false);
  });

  // The control. Restricting is the whole change; refusing everything would be a different bug —
  // an allowWrites:false project would silently lose every tool it legitimately had.
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

  /**
   * The heuristic became load-bearing when the hint stopped being able to override it, so the verbs
   * it does not know are now the gap. Each of these reads as a mutation to a person.
   */
  it("knows the verbs it had to learn once the hint could no longer override it", () => {
    for (const name of [
      "search_and_destroy",
      "get_then_purge_cache",
      "list_and_reset_counters",
      "find_and_merge_duplicates",
      "read_and_execute_script",
      "query_then_revoke_tokens",
      // BP-476: verbs the list did not know, each passing as a read before
      "get_or_add_label",
      "find_and_save_draft",
      "list_and_publish_posts",
      "find_and_cancel_jobs",
      "get_then_disable_rule",
      "get_or_enable_feature",
      "listAndUpsert",
      "fetch_and_submit_form",
    ]) {
      expect(isReadSafe(tool(name, true)), name).toBe(false);
    }
  });

  /**
   * The other half of the same change, and the one a control over three invented names could not
   * see. Matched as a substring, every name here was refused — and on a project with writes off a
   * refusal is final, because `toolAllowlist` only narrows and never restores. These are real tool
   * names from the GitHub MCP server and its neighbours.
   */
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
      // Nouns as often as verbs, left off the list on purpose
      "get_commit",
      "list_commits",
      "list_push_rules",
      "get_import_status",
      "list_deploy_keys",
      "get_sync_status",
      "get_address",           // "add", token is "address"
      "list_enabled_features", // "enable", token is "enabled"
      "list_published_packages",
      "get_saved_searches",
    ]) {
      expect(isReadSafe(tool(name)), name).toBe(true);
    }
  });

  // A mutation never reaches the verb list at all unless it is dressed as a read, which is what
  // makes leaving `run` and `grant` out of it safe
  it("refuses a name that does not start as a read, whatever it contains", () => {
    for (const name of ["run_script", "grant_access", "do_the_thing", "trigger_deploy"]) {
      expect(isReadSafe(tool(name, true)), name).toBe(false);
    }
  });

  // BP-476 review: real read tools the prefix rule refused, and near-misses it let through
  it("accepts the official GitHub server's noun-first reads", () => {
    for (const name of ["issue_read", "pull_request_read"]) {
      expect(isReadSafe(tool(name)), name).toBe(true);
    }
  });

  it("looks past the server's own name at the front of a tool's name", () => {
    expect(isReadSafe(tool("notion-search"), "notion")).toBe(true);
    expect(isReadSafe(tool("slack_list_channels"), "slack")).toBe(true);
    // Only the server's own name: another word in front is not a prefix to skip
    expect(isReadSafe(tool("notion-search"), "github")).toBe(false);
    expect(isReadSafe(tool("notion-create-pages"), "notion")).toBe(false);
  });

  it("wants a read verb as a whole word, not the start of a longer one", () => {
    for (const name of ["readjust_budget", "listen_for_webhooks", "getaway_plan"]) {
      expect(isReadSafe(tool(name)), name).toBe(false);
    }
  });

  it("does not take a read verb at the end as a read unless it is `read`, or a mutation marks it", () => {
    for (const name of ["export_to_search", "rebuild_list", "mark_all_notifications_read", "mark_read"]) {
      expect(isReadSafe(tool(name)), name).toBe(false);
    }
  });
});
