import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * BP-321. `runPmTurn`'s `autonomous` flag is what withholds a project's MCP write tools from a turn
 * nobody is driving — `disallowedTools` cannot, because it matches exact names and MCP tools are
 * exposed as `mcp_<server>_<tool>`.
 *
 * It is one word at each call site, and the risk is a third unattended entry point added later
 * without it. That is not a behaviour any single unit test can see, so it is asserted here over the
 * source: every caller is found, and each is judged by whether a person is driving it.
 */
const ROOT = join(process.cwd(), "src");

function filesCalling(name: string): string[] {
  const found: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
        if (readFileSync(path, "utf8").includes(`${name}({`)) found.push(path);
      }
    }
  };
  walk(ROOT);
  return found;
}

/** Where a person typed the message. Everything else runs on a schedule or a board event. */
const ATTENDED = ["pm/chat/route.ts"];

describe("every turn nobody is driving says so", () => {
  const callers = filesCalling("runPmTurn");

  it("finds the call sites at all, so this cannot pass by scanning nothing", () => {
    expect(callers.length).toBeGreaterThanOrEqual(3);
  });

  for (const path of filesCalling("runPmTurn")) {
    const relative = path.slice(ROOT.length + 1);
    const attended = ATTENDED.some((a) => relative.replace(/\\/g, "/").endsWith(a));
    const source = readFileSync(path, "utf8");

    it(`${relative} ${attended ? "does not claim to be autonomous" : "passes autonomous: true"}`, () => {
      expect(/autonomous:\s*true/.test(source)).toBe(!attended);
    });
  }
});
