import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { GROUPS } from "./groups";

const specs = readdirSync(join(__dirname)).filter((f) => f.endsWith(".spec.ts"));
const grouped: string[] = Object.values(GROUPS).flat();

it("runs every group in CI — a group with no job is a group that never runs", () => {
  const workflow = readFileSync(join(__dirname, "..", ".github", "workflows", "ci.yml"), "utf8");
  const listed = workflow.match(/# e2e-groups-start\s*\n\s*group: \[([^\]]*)\]/);
  expect(listed, "the marked group list is missing from ci.yml").not.toBeNull();
  expect(listed![1].split(",").map((n) => n.trim()).sort()).toEqual(Object.keys(GROUPS).sort());
});

describe("every end-to-end spec belongs to exactly one group", () => {
  it("names no spec that does not exist", () => {
    expect(grouped.filter((f) => !specs.includes(f))).toEqual([]);
  });

  it("leaves no spec out — one left out runs in no CI job at all", () => {
    expect(specs.filter((f) => !grouped.includes(f))).toEqual([]);
  });

  it("puts no spec in two groups, which would run it twice", () => {
    expect(grouped.filter((f, i) => grouped.indexOf(f) !== i)).toEqual([]);
  });
});
