import { describe, it, expect } from "vitest";
import {
  CAPABILITIES_HEADER,
  capabilities,
  capabilityHeaders,
  MULTI_REPOSITORY,
  SAYS_IT_RUNS_SEVERAL_REPOSITORIES,
} from "./capabilities.js";

// BP-1073. Said only once a real worker has carried a task through two repositories in CI; said
// earlier, the first project that lists several would be handed to a worker nobody has watched run one.
describe("what this worker says it can do", () => {
  it("names the capability the server looks for, spelt the way the server spells it", () => {
    expect(MULTI_REPOSITORY).toBe("multi-repository");
    expect(CAPABILITIES_HEADER).toBe("X-CP-Capabilities");
  });

  it("says it runs several repositories", () => {
    expect(SAYS_IT_RUNS_SEVERAL_REPOSITORIES).toBe(true);
    expect(capabilities()).toEqual([MULTI_REPOSITORY]);
    expect(capabilityHeaders()).toEqual({ "X-CP-Capabilities": "multi-repository" });
  });

  it("sends no header at all once the capability is taken back, so the server hands this worker no such project", () => {
    expect(capabilities(false)).toEqual([]);
    expect(capabilityHeaders(false)).toEqual({});
  });
});
