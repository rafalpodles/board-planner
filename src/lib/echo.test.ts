import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { ECHO_LIMIT, echo } from "./echo";

/**
 * BP-564. Every message that quotes a caller's own words back reaches a model as an MCP tool
 * result, so an unbounded one lets the caller spend the reader's context on a string of its own
 * choosing. BP-515 fixed four such sites with an inline slice; the four this ticket found were
 * missed because there was no name to grep for.
 */

describe("echo", () => {
  it("leaves a value that is already short alone", () => {
    expect(echo("Platform")).toBe("Platform");
    expect(echo("x".repeat(ECHO_LIMIT))).toBe("x".repeat(ECHO_LIMIT));
  });

  it("bounds a long one, and says it did", () => {
    const out = echo("x".repeat(50_000));
    expect(out).toHaveLength(ECHO_LIMIT + 1);
    expect(out.endsWith("…")).toBe(true);
  });

  // Callers reach this from JSON, so the value is not always a string
  it("takes anything a caller can send", () => {
    expect(echo(undefined)).toBe("undefined");
    expect(echo(null)).toBe("null");
    expect(echo(12)).toBe("12");
    expect(echo({ a: 1 })).toBe("[object Object]");
    expect(echo(["x".repeat(200)]).length).toBe(ECHO_LIMIT + 1);
  });
});

/**
 * `mcp-server` is built as its own package and `vitest.config.ts` scopes `include` to `src/**`, so
 * a copy that drifts compiles clean on both sides and nothing says a word — the reason
 * api-client-drift.test.ts exists. The same applies here, and this file is the one place the bound
 * is stated.
 */
describe("the standalone copy of the bound", () => {
  const here = readFileSync(join(process.cwd(), "src/lib/echo.ts"), "utf8");
  const there = readFileSync(join(process.cwd(), "mcp-server/src/echo.ts"), "utf8");

  it("is the same file", () => {
    expect(there).toBe(here);
  });
});
