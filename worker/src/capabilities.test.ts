import { describe, it, expect } from "vitest";
import { capabilities, MULTI_REPOSITORY, RUNS_SEVERAL_REPOSITORIES } from "./capabilities.js";

// BP-1067. Pinned until BP-1073 turns it on: a worker that said it could run several repositories
// before its run could would be handed projects it would run in one of them.
describe("what this worker says it can do", () => {
  it("names nothing while a run cannot take several repositories", () => {
    expect(RUNS_SEVERAL_REPOSITORIES).toBe(false);
    expect(capabilities()).toEqual([]);
  });

  it("names the capability the server looks for, spelt the way the server spells it", () => {
    expect(MULTI_REPOSITORY).toBe("multi-repository");
  });
});
