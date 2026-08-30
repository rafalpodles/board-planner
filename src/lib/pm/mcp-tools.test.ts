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
   * it does not know are now the gap. These are the ones added with that change; each reads as a
   * mutation to a person and passed the old list.
   */
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
});
