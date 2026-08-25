import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { GROUPS } from "./groups";

// Recursive, because `testDir: "./e2e"` is: a spec in a subdirectory is collected by Playwright
// and would be invisible to a flat listing — running in no job at all, which is the one thing
// this file exists to prevent.
const specs = readdirSync(join(__dirname), { recursive: true, encoding: "utf8" }).filter((f) =>
  f.endsWith(".spec.ts")
);
const grouped: string[] = Object.values(GROUPS).flat();
const workflow = readFileSync(join(__dirname, "..", ".github", "workflows", "ci.yml"), "utf8");

describe("the CI jobs and the groups agree", () => {
  it("runs every group as a job", () => {
    const listed = workflow.match(/# e2e-groups-start\s*\n\s*group: \[([^\]]*)\]/);
    expect(listed, "the marked group list is missing from ci.yml").not.toBeNull();
    expect(listed![1].split(",").map((n) => n.trim()).sort()).toEqual(Object.keys(GROUPS).sort());
  });

  // The list above says which jobs exist. These two say the jobs still run what they are named
  // for — a matrix `exclude:` deletes a job outright, and a hardcoded --project makes five of the
  // six run the same group. Both leave the list itself untouched.
  it("takes no group back out of the matrix", () => {
    const strategy = workflow.slice(
      workflow.indexOf("# e2e-groups-start"),
      workflow.indexOf("services:", workflow.indexOf("# e2e-groups-start"))
    );
    expect(strategy).not.toMatch(/\b(exclude|include):/);
  });

  it("runs the group the job is named for", () => {
    expect(workflow).toContain("npx playwright test --project=${{ matrix.group }}");
  });
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
