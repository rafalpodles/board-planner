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

  // The first version stopped at `[^,)]+`, so it truncated the captured expression at the closing
  // paren of the FIRST seg(...) — every path yielded zero interpolations and the filter below could
  // never flag anything. It survived its mutation only by accident: removing seg() removes the
  // paren too, which let the capture run on to the end. Match to the closing quote instead.
  function pathExpressions(): string[] {
    return [...source.matchAll(/this\.request\(\s*"[A-Z]+"\s*,\s*(`[^`]*`|"[^"]*")/g)].map(
      ([, expr]) => expr.trim()
    );
  }

  function interpolationsIn(expr: string): string[] {
    return [...expr.matchAll(/\$\{([^}]*)\}/g)].map(([, inner]) => inner.trim());
  }

  // Guards the guard. A scan that stops seeing anything goes quiet rather than failing, which is
  // precisely how the check below was broken while looking healthy.
  it("can actually see the interpolated segments", () => {
    expect(pathExpressions().flatMap(interpolationsIn).length).toBeGreaterThanOrEqual(11);
  });

  // `${query}` is an already-built query string appended after the path, not a segment
  it("routes every id it puts in a path through an encoder", () => {
    const unencoded = pathExpressions().filter((expr) => {
      const concatenated = expr.includes("+");
      return (
        concatenated || interpolationsIn(expr).some((i) => i !== "query" && !i.startsWith("seg("))
      );
    });

    expect(unencoded).toEqual([]);
  });

  async function bothClients() {
    const { ApiClient } = await import("../../../mcp-server/src/api-client");
    return {
      standalone: new ApiClient("https://board.example.com", { token: "cp_x" }),
      planner: new PlannerClient("https://board.example.com", "cp_x"),
    };
  }

  // Stubbed even though the guard should throw first: without it, a regression here stops being a
  // test failure and starts being four real outbound requests
  async function withStubbedFetch(run: () => Promise<void>): Promise<string[]> {
    const calls: string[] = [];
    const original = globalThis.fetch;
    globalThis.fetch = ((url: string) => {
      calls.push(url);
      return Promise.resolve(new Response("{}", { headers: { "content-type": "application/json" } }));
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as any;
    try {
      await run();
    } finally {
      globalThis.fetch = original;
    }
    return calls;
  }

  // The fix for BP-339 had to land in both copies, and "I edited both files" is not evidence
  it.each(["..", ".", "", "a/../b", "//attacker.example/x"])(
    "refuses the segment %o in both clients, and fetches nothing",
    async (value) => {
      const { standalone, planner } = await bothClients();

      const calls = await withStubbedFetch(async () => {
        await expect(standalone.getTask(value, "t1")).rejects.toThrow(/Invalid path segment/);
        await expect(planner.getTask(value, "t1")).rejects.toThrow(/Invalid path segment/);
      });

      expect(calls).toEqual([]);
    }
  );

  it("builds the identical URL for an ordinary id", async () => {
    const { standalone, planner } = await bothClients();

    const calls = await withStubbedFetch(async () => {
      await standalone.getTask("507f1f77bcf86cd799439011", "507f1f77bcf86cd799439012");
      await planner.getTask("507f1f77bcf86cd799439011", "507f1f77bcf86cd799439012");
    });

    expect(calls[0]).toBe(calls[1]);
    expect(new URL(calls[0]).pathname).toBe(
      "/api/projects/507f1f77bcf86cd799439011/tasks/507f1f77bcf86cd799439012"
    );
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
