import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { PlannerClient } from "./planner-client";

const STANDALONE = join(process.cwd(), "mcp-server/src/api-client.ts");

/**
 * mcp-server ships a copy of PlannerClient. It is built as its own package and `vitest.config.ts`
 * scopes `include` to `src/**`, so a fix applied to one and not the other compiles clean on both
 * sides and nothing says a word — which is how the unencoded path interpolation BP-316 removed here
 * stayed in place there.
 *
 * So this checks the two files agree, and checks it by shape rather than by matching source text:
 * the first version of this guard passed if `seg` was defined and never called, and only saw paths
 * built from a template literal starting with `/api/` (BP-316 review).
 */
describe("the standalone MCP client does not drift from PlannerClient", () => {
  const source = readFileSync(STANDALONE, "utf8");

  function pathExpressions(): string[] {
    // Every second argument to this.request(...) — however it is built
    return [...source.matchAll(/this\.request\(\s*"[A-Z]+"\s*,\s*([^,)]+(?:,|\))?)/g)].map(
      ([, expr]) => expr.replace(/[,)]$/, "").trim()
    );
  }

  it("routes every id it puts in a path through an encoder", () => {
    const unencoded = pathExpressions().filter((expr) => {
      const interpolations = [...expr.matchAll(/\$\{([^}]*)\}/g)].map(([, inner]) => inner.trim());
      const concatenated = expr.includes("+");
      return concatenated || interpolations.some((i) => i !== "query" && !i.startsWith("seg("));
    });

    expect(unencoded).toEqual([]);
  });

  // The fix for BP-339 had to land in both copies, and "I edited both files" is not evidence
  it.each(["..", ".", ""])("refuses the segment %o in both clients", async (value) => {
    const { ApiClient } = await import("../../../mcp-server/src/api-client");
    const standalone = new ApiClient("https://board.example.com", { token: "cp_x" });
    const planner = new PlannerClient("https://board.example.com", "cp_x");

    await expect(standalone.getTask(value, "t1")).rejects.toThrow(/Invalid path segment/);
    await expect(planner.getTask(value, "t1")).rejects.toThrow(/Invalid path segment/);
  });

  it("encodes a traversal attempt the same way PlannerClient does", async () => {
    const { ApiClient } = await import("../../../mcp-server/src/api-client");
    const calls: string[] = [];
    const capture = (url: string) => {
      calls.push(url);
      return Promise.resolve(new Response("{}", { headers: { "content-type": "application/json" } }));
    };

    const standalone = new ApiClient("https://board.example.com", { token: "cp_x" });
    const planner = new PlannerClient("https://board.example.com", "cp_x");

    const original = globalThis.fetch;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    globalThis.fetch = capture as any;
    try {
      await standalone.getTask("a/../b", "c/../d").catch(() => {});
      await planner.getTask("a/../b", "c/../d").catch(() => {});
    } finally {
      globalThis.fetch = original;
    }

    expect(calls[0]).toBe(calls[1]);
    expect(new URL(calls[0]).pathname).not.toContain("/b");
  });

  // resolveTaskKey lives in mcp-server/src/index.ts rather than on its client — the one divergence
  // that is deliberate. Anything else appearing here means a method was added on one side only.
  it("still offers every method the in-app client does", async () => {
    const { ApiClient } = await import("../../../mcp-server/src/api-client");
    const missing = Object.getOwnPropertyNames(PlannerClient.prototype)
      .filter((name) => name !== "constructor" && name !== "request")
      .filter((name) => !(name in ApiClient.prototype));

    expect(missing).toEqual(["resolveTaskKey"]);
  });
});
