import { describe, it, expect } from "vitest";
import sift from "sift";
import { PROJECT_RUNS_WORKERS_QUERY, projectRunsWorkers } from "./worker-gate";

describe("projectRunsWorkers", () => {
  it.each([
    [{ enabled: true }, true],
    [{ enabled: true, lockedByInstance: false }, true],
    [{ enabled: true, lockedByInstance: true }, false],
    [{ enabled: false, lockedByInstance: false }, false],
    [{ enabled: false, lockedByInstance: true }, false],
    [undefined, false],
    [null, false],
  ])("%j runs workers: %s", (worker, expected) => {
    expect(projectRunsWorkers(worker)).toBe(expected);
  });

  // The bulk query the heartbeat selects with has to reach the same verdict as the function
  it.each([
    [{ enabled: true }, true],
    [{ enabled: true, lockedByInstance: false }, true],
    [{ enabled: true, lockedByInstance: true }, false],
    [{ enabled: false }, false],
    [undefined, false],
  ])("the query agrees for %j", (worker, expected) => {
    const doc = worker === undefined ? {} : { worker };

    expect(sift(PROJECT_RUNS_WORKERS_QUERY)(doc)).toBe(expected);
    expect(projectRunsWorkers((doc as { worker?: typeof worker }).worker)).toBe(expected);
  });
});
