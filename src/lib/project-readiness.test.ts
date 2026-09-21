import { describe, it, expect } from "vitest";
import { readinessGaps } from "./project-readiness";

const READY = { repositoryUrl: "https://github.com/acme/orbit", workerEnabled: true, machine: "live" as const };

describe("readinessGaps", () => {
  it("finds nothing on a board with a repository, runs on, and a live machine", () => {
    expect(readinessGaps(READY)).toEqual([]);
  });

  it.each([undefined, null, "", "   "])("names a board whose repository is %o", (repositoryUrl) => {
    expect(readinessGaps({ ...READY, repositoryUrl })).toEqual(["no-repository"]);
  });

  // Only an explicit true switches runs on: an absent worker block is a board nobody enabled
  it.each([false, undefined, null])("names runs as off when enabled is %o", (workerEnabled) => {
    expect(readinessGaps({ ...READY, workerEnabled })).toEqual(["runs-off"]);
  });

  it("names a reader with no machine serving the repository", () => {
    expect(readinessGaps({ ...READY, machine: "none" })).toEqual(["no-machine"]);
  });

  it("names a machine that has stopped reporting in", () => {
    expect(readinessGaps({ ...READY, machine: "stale" })).toEqual(["machine-stale"]);
  });

  // The machine is known only to its owner; a colleague's view must not invent a gap from silence
  it.each([undefined, null])("does not judge a machine that is %o", (machine) => {
    expect(readinessGaps({ ...READY, machine })).toEqual([]);
  });

  it("lists every gap at once, board-level first", () => {
    expect(readinessGaps({ repositoryUrl: "", workerEnabled: false, machine: "none" })).toEqual([
      "no-repository",
      "runs-off",
      "no-machine",
    ]);
  });
});
