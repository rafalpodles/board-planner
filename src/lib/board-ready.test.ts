import { describe, it, expect } from "vitest";
import { boardReadyComplete, boardReadySteps, type BoardReadyFacts } from "./board-ready";

const BARE: BoardReadyFacts = {
  hasTasks: false,
  grantCount: 1,
  repositoryUrl: "",
  workerEnabled: false,
  lockedByInstance: false,
  machine: "none",
  readerIsInstanceAdmin: false,
};

const done = (facts: Partial<BoardReadyFacts>) =>
  Object.fromEntries(boardReadySteps({ ...BARE, ...facts }).map((s) => [s.id, s.done]));

describe("boardReadySteps", () => {
  it("has the board itself done and the rest open on a bare board", () => {
    expect(done({})).toEqual({
      board: true,
      tasks: false,
      team: false,
      repository: false,
      runs: false,
      machine: false,
    });
  });

  it("splits the steps into setup and agents", () => {
    const groups = boardReadySteps(BARE).map((s) => [s.id, s.group]);
    expect(groups).toEqual([
      ["board", "setup"],
      ["tasks", "setup"],
      ["team", "setup"],
      ["repository", "agents"],
      ["runs", "agents"],
      ["machine", "agents"],
    ]);
  });

  it("counts the team as done only past the owner alone", () => {
    expect(done({ grantCount: 1 }).team).toBe(false);
    expect(done({ grantCount: 2 }).team).toBe(true);
  });

  it("does not take a blank repository for one", () => {
    expect(done({ repositoryUrl: "   " }).repository).toBe(false);
    expect(done({ repositoryUrl: "https://github.com/acme/orbit" }).repository).toBe(true);
  });

  it("lets the instance lock win over the owner's switch", () => {
    expect(done({ workerEnabled: true, lockedByInstance: true }).runs).toBe(false);
    expect(done({ workerEnabled: true }).runs).toBe(true);
  });

  it("is done for a machine only when it is live", () => {
    for (const machine of ["none", "disabled", "stale", "held", "unbound", "paused", "stopped", "failing"] as const) {
      expect(done({ machine }).machine, machine).toBe(false);
    }
    expect(done({ machine: "live" }).machine).toBe(true);
  });

  describe("locked", () => {
    const locked = (facts: Partial<BoardReadyFacts>) =>
      boardReadySteps({ ...BARE, workerEnabled: true, lockedByInstance: true, ...facts }).find((s) => s.id === "runs")!
        .locked;

    it("is set for an owner who cannot lift the lock", () => {
      expect(locked({})).toBe(true);
    });

    it("is not set for an instance admin, who can", () => {
      expect(locked({ readerIsInstanceAdmin: true })).toBe(false);
    });

    it("is not set when nothing is locked", () => {
      expect(locked({ lockedByInstance: false })).toBe(false);
    });
  });
});

describe("boardReadyComplete", () => {
  it("needs every step done", () => {
    const all = boardReadySteps({
      hasTasks: true,
      grantCount: 3,
      repositoryUrl: "https://github.com/acme/orbit",
      workerEnabled: true,
      lockedByInstance: false,
      machine: "live",
      readerIsInstanceAdmin: false,
    });
    expect(boardReadyComplete(all)).toBe(true);
    expect(boardReadyComplete(boardReadySteps(BARE))).toBe(false);
  });
});
