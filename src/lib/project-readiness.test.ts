import { describe, it, expect } from "vitest";
import { missingRunRoles, readinessGaps } from "./project-readiness";

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

  it.each([
    ["paused", "machine-paused"],
    ["failing", "machine-failing"],
  ] as const)("names a %s machine", (machine, gap) => {
    expect(readinessGaps({ ...READY, machine })).toEqual([gap]);
  });

  // With no repository no machine can serve the board; "connect one" would be advice that cannot work
  it("does not also name the machine on a board with no repository", () => {
    expect(readinessGaps({ ...READY, repositoryUrl: "", machine: "none" })).toEqual(["no-repository"]);
  });

  it.each([
    [["approved", "active", "review", "done"], []],
    [["approved", "active", "done"], ["missing-columns"]],
    [["backlog", "approved", "active", "review"], ["missing-columns"]],
  ] as const)("judges a board with the roles %o", (roles, expected) => {
    const columns = roles.map((role, order) => ({ id: role, label: role, color: "#888", role, order }));
    expect(readinessGaps({ ...READY, columns })).toEqual(expected);
  });

  it("names a machine that has stopped reporting in", () => {
    expect(readinessGaps({ ...READY, machine: "stale" })).toEqual(["machine-stale"]);
  });

  // The machine is known only to its owner; a colleague's view must not invent a gap from silence
  it.each([undefined, null])("does not judge a machine that is %o", (machine) => {
    expect(readinessGaps({ ...READY, machine })).toEqual([]);
  });

  it("lists every gap at once, board-level first", () => {
    expect(
      readinessGaps({ repositoryUrl: "", workerEnabled: false, columns: [], machine: "stale" })
    ).toEqual(["no-repository", "runs-off", "missing-columns"]);
  });
});

describe("missingRunRoles", () => {
  it("lists the roles a run needs that no column carries, in the order a run needs them", () => {
    const columns = [{ id: "a", label: "a", color: "#888", role: "active" as const, order: 0 }];
    expect(missingRunRoles(columns)).toEqual(["approved", "review", "done"]);
  });
});
