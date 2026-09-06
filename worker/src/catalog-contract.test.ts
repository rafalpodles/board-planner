import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const APP_SRC = join(import.meta.dirname, "..", "..", "src");

function source(...parts: string[]): string {
  return readFileSync(join(APP_SRC, ...parts), "utf8");
}

function keysOf(list: string, pattern: RegExp): string[] {
  return [...list.matchAll(pattern)].map((match) => match[1]).sort();
}

describe("the gate kinds the catalog offers", () => {
  it("are exactly the ones gateFromEntry builds", () => {
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
    const accepted = keysOf(block.slice(0, block.indexOf("]")), /"([a-z]+)"/g);

    const record = readFileSync(join(import.meta.dirname, "run-record.ts"), "utf8");
    const mapping = record.slice(record.indexOf("OUTCOMES: Record"));
    const sent = keysOf(mapping.slice(0, mapping.indexOf("};")), /: "([a-z]+)",/g);

    expect(accepted.length).toBeGreaterThan(0);
    expect(accepted).toEqual(expect.arrayContaining(sent));
  });
});
