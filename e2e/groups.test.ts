import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { GROUPS } from "./groups";
import { SMOKES } from "./smoke/smokes";

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

describe("every live smoke runs in a CI job of its own", () => {
  const smokeFiles = readdirSync(join(__dirname, "smoke")).filter((f) => f.endsWith(".smoke.ts"));

  it("names every smoke file in SMOKES, and nothing else", () => {
    expect(Object.values(SMOKES).sort()).toEqual(smokeFiles.sort());
  });

  it("runs the worker smoke on macOS, where it does not skip itself", () => {
    const job = workflow.match(/^  smoke_worker:\n(?:(?: {4}.*)?\n)*/m)?.[0] ?? "";
    expect(job).toMatch(/^ {4}runs-on: macos-/m);
  });

  it("runs each smoke project from ci.yml", () => {
    for (const name of Object.keys(SMOKES)) {
      expect(workflow).toContain(`npx playwright test -c playwright.smoke.config.ts --project=${name}`);
    }
  });
});

describe("the CI passed gate", () => {
  const jobsBlock = workflow.slice(workflow.indexOf("\njobs:\n"));
  const jobIds = [...jobsBlock.matchAll(/^ {2}([A-Za-z0-9_-]+):/gm)].map((m) => m[1]);
  const gate = jobsBlock.match(/^ {2}ci-passed:\n(?:(?: {4}.*)?\n?)*/m)?.[0] ?? "";
  const needed = [...(gate.match(/^ {4}needs:\n((?: {6}- .*\n)*)/m)?.[1] ?? "").matchAll(/- (\S+)/g)].map(
    (m) => m[1]
  );

  it("needs every other job, so a job added later cannot fail unnoticed", () => {
    expect(jobIds).toContain("ci-passed");
    expect(needed.sort()).toEqual(jobIds.filter((id) => id !== "ci-passed").sort());
  });

  it("runs even when a needed job failed", () => {
    expect(gate).toMatch(/^ {4}if: always\(\)$/m);
  });
});
