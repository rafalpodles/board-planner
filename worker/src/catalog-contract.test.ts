import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Two lists live on the server and are implemented here, and the worker is a separate package —
 * importing the app's types would drag its whole graph across the boundary. Same shape as
 * tool-restriction.contract.test.ts: read the source as text and compare.
 *
 * Drift is not theoretical. A gate kind the catalog offers and this worker does not implement dies
 * mid-task, after the agent has already done the work; an outcome the server's own list does not
 * carry is a 400 on the run record, at the one moment the run has nothing left to retry with.
 */
const APP_SRC = join(import.meta.dirname, "..", "..", "src");

function source(...parts: string[]): string {
  return withoutComments(readFileSync(join(APP_SRC, ...parts), "utf8"));
}

/**
 * Both lists are read out of source text, and a comment in either is prose that looks exactly like
 * the thing being matched. On the server's side a commented-out value still named in quotes read as
 * one the server accepts, hiding its own removal; on the worker's, a comment naming a superseded
 * mapping read as an extra outcome and failed the test for nothing. Both measured (found in review).
 */
function withoutComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

function keysOf(list: string, pattern: RegExp): string[] {
  return [...list.matchAll(pattern)].map((match) => match[1]).sort();
}

describe("the gate kinds the catalog offers", () => {
  it("are exactly the ones gateFromEntry builds", () => {
    // `key: "diff-size",` — each GateKind's own key, and nothing else in that file uses the form
    const offered = keysOf(source("lib", "agent-kinds.ts"), /^\s{4}key: "([a-z-]+)",$/gm);

    const factory = readFileSync(join(import.meta.dirname, "gates", "from-entry.ts"), "utf8");
    const implemented = keysOf(factory, /^\s*case "([a-z-]+)":$/gm);

    expect(offered.length).toBeGreaterThan(0);
    expect(implemented).toEqual(offered);
  });
});

describe("the outcomes the server records", () => {
  it("are exactly the ones the worker maps its own onto", () => {
    const types = source("types", "index.ts");
    const block = types.slice(types.indexOf("AGENT_RUN_OUTCOMES = ["));
    // `[a-zA-Z]`, not `[a-z]`: a camelCase outcome on either side was invisible to this test, so
    // the one shape a drift is most likely to take — a name copied from the worker's own
    // vocabulary — was the shape it could not see.
    const accepted = keysOf(block.slice(0, block.indexOf("]")), /"([a-zA-Z]+)"/g);

    const record = withoutComments(
      readFileSync(join(import.meta.dirname, "run-record.ts"), "utf8")
    );
    const mapping = record.slice(record.indexOf("OUTCOMES: Record"));
    const sent = keysOf(mapping.slice(0, mapping.indexOf("};")), /: "([a-zA-Z]+)",/g);

    // Both halves read every entry they are looking at. Containment alone cannot see a regex that
    // has gone blind on BOTH sides at once — the value vanishes from `accepted` and `sent` together
    // and the assertion still holds — so each side is counted against its own source first.
    const body = mapping.slice(mapping.indexOf("{") + 1, mapping.indexOf("};"));
    const declared = [...body.matchAll(/^\s*\w+:/gm)].length;
    expect(sent.length).toBe(declared);
    expect(accepted.length).toBe(
      [...block.slice(0, block.indexOf("]")).matchAll(/^\s*"/gm)].length
    );

    // Every outcome the worker sends is one the server takes. The server may carry more than the
    // worker ever produces, so this is containment rather than equality.
    expect(accepted).toEqual(expect.arrayContaining(sent));
  });
});
