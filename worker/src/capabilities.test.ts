import { describe, it, expect } from "vitest";
import { capabilities, MULTI_REPOSITORY, SAYS_IT_RUNS_SEVERAL_REPOSITORIES } from "./capabilities.js";

// BP-1067. Pinned until BP-1073 turns it on: said before the smoke test and the docs, the first project
// that lists several repositories would be handed to a worker nobody has watched run one.
describe("what this worker says it can do", () => {
  it("names nothing until the capability is turned on", () => {
    expect(SAYS_IT_RUNS_SEVERAL_REPOSITORIES).toBe(false);
    expect(capabilities()).toEqual([]);
  });

  it("names the capability the server looks for, spelt the way the server spells it", () => {
    expect(MULTI_REPOSITORY).toBe("multi-repository");
  });
});
