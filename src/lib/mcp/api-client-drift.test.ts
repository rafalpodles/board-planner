import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

const STANDALONE = join(process.cwd(), "mcp-server/src/api-client.ts");

/**
 * mcp-server ships a copy of PlannerClient. It is built as its own package, so a fix applied to one
 * and not the other compiles clean on both sides and nothing says a word — which is how the
 * unencoded path interpolation BP-316 removed here stayed in place there.
 *
 * The encoding is worth less than the drift check: this reads the shipped file rather than
 * exercising it, because the package has no test runner of its own.
 */
describe("the standalone MCP client does not drift from PlannerClient", () => {
  const source = readFileSync(STANDALONE, "utf8");

  // `${query}` is an already-built query string appended after the path, not a segment
  it("encodes rather than interpolates every id it puts in a path", () => {
    const raw = [...source.matchAll(/`\/api\/[^`]*`/g)]
      .map(([template]) => template)
      .filter((template) => /\$\{(?!seg\(|query\})/.test(template));

    expect(raw).toEqual([]);
  });

  it("still defines seg as an encoder", () => {
    expect(source).toMatch(/const seg = \(value: string\) => encodeURIComponent\(value\)/);
  });
});
