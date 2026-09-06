import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { PlannerClient } from "./planner-client";

const STANDALONE = join(process.cwd(), "mcp-server/src/api-client.ts");

describe("the standalone MCP client does not drift from PlannerClient", () => {
  const source = readFileSync(STANDALONE, "utf8");

  function pathExpressions(): string[] {
    return [...source.matchAll(/this\.request\(\s*"[A-Z]+"\s*,\s*(`[^`]*`|"[^"]*")/g)].map(
      ([, expr]) => expr.trim()
    );
  }

  function interpolationsIn(expr: string): string[] {
    return [...expr.matchAll(/\$\{([^}]*)\}/g)].map(([, inner]) => inner.trim());
  }

  it("can actually see the interpolated segments", () => {
    expect(pathExpressions().flatMap(interpolationsIn).length).toBeGreaterThanOrEqual(11);
  });

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

  it("still offers every method the in-app client does", async () => {
    const { ApiClient } = await import("../../../mcp-server/src/api-client");
    const missing = Object.getOwnPropertyNames(PlannerClient.prototype)
      .filter((name) => name !== "constructor" && name !== "request")
      .filter((name) => !(name in ApiClient.prototype));

    expect(missing).toEqual(["resolveTaskKey"]);
  });
});

describe("the standalone MCP server keeps the strict input the in-app one has", () => {
  const IN_APP_HELPER = join(process.cwd(), "src/lib/mcp/strict-input.ts");
  const STANDALONE_HELPER = join(process.cwd(), "mcp-server/src/strict-input.ts");

  it("ships a byte-identical copy of the helper", () => {
    expect(readFileSync(STANDALONE_HELPER, "utf8")).toBe(readFileSync(IN_APP_HELPER, "utf8"));
  });
});
