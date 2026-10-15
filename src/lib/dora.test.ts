import { describe, it, expect } from "vitest";
import { computeDora, type DoraDeployment } from "./dora";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NOW = Date.UTC(2026, 9, 15, 12);
const at = (daysAgo: number) => new Date(NOW - daysAgo * DAY);
const deploy = (sha: string, state: DoraDeployment["state"], startedDaysAgo: number, tookHours = 1): DoraDeployment => ({
  sha,
  state,
  startedAt: at(startedDaysAgo),
  finishedAt: state === "pending" ? null : new Date(at(startedDaysAgo).getTime() + tookHours * HOUR),
});
const options = { now: NOW, weeks: 2, environment: "production", syncedThrough: at(0.1), rateLimitedUntil: null };

describe("computeDora — a hand computation", () => {
  // Days ago:  10 success(a) · 8 failure(b) · 7.5 failure(c) · 7 success(d) · 3 success(e) · 1 pending(f)
  const deployments = [
    deploy("a", "success", 10),
    deploy("b", "failure", 8),
    deploy("c", "error", 7.5),
    deploy("d", "success", 7),
    deploy("e", "success", 3),
    deploy("f", "pending", 1),
  ];
  const changes = [
    { url: "pr/1", headSha: "a", mergedAt: at(11) },
    { url: "pr/2", headSha: "zz", mergedAt: at(7.25) },
    { url: "pr/3", headSha: null, mergedAt: at(4) },
    { url: "pr/3", headSha: null, mergedAt: at(4) },
    { url: "pr/4", headSha: null, mergedAt: at(0.5) },
  ];

  const dora = computeDora(deployments, changes, options);

  it("deployment frequency counts successful deployments per week, by when they started", () => {
    expect(dora.deployments).toBe(5);
    // The window's weeks are 14–7 and 7–0 days ago; d, exactly 7 days ago, opens the second
    expect(dora.weekly.map((w) => [w.successes, w.failures])).toEqual([
      [1, 2],
      [2, 0],
    ]);
    expect(dora.deploymentsPerWeek).toBe(1.5);
  });

  it("change failure rate is failures over every finished deployment; a pending one is neither", () => {
    expect(dora.changeFailureRate).toBe(2 / 5);
  });

  it("time to restore runs from the first failure of a run to the next success going live", () => {
    // b went live 8 d − 1 h ago; d went live 7 d − 1 h ago: one day. c is part of b's run.
    expect(dora.timeToRestore).toEqual({ count: 1, medianMs: DAY, p85Ms: DAY });
    expect(dora.unrestored).toBe(0);
  });

  it("lead time for changes: head-commit match first, otherwise the first success after the merge", () => {
    // pr/1 → a by sha: 11 d − (10 d − 1 h) = 1 d + 1 h
    // pr/2 → no deploy of zz; first success after 7.25 d ago is d: 7.25 − 7 d + 1 h = 7 h
    // pr/3 (twice, one change) → e: 4 − 3 d + 1 h = 1 d + 1 h
    // pr/4 → nothing has shipped it yet, so it is not counted
    // sorted 7 h, 25 h, 25 h → median 25 h, p85 = 25 h
    expect(dora.leadTimeForChanges).toEqual({ count: 3, medianMs: 25 * HOUR, p85Ms: 25 * HOUR });
  });

  it("a successful deployment that shipped no linked change counts only for frequency", () => {
    expect(dora.deploymentsWithoutChanges).toBe(0);
    const unmatched = computeDora([...deployments, deploy("g", "success", 2)], changes, options);
    expect(unmatched.deploymentsWithoutChanges).toBe(1);
    expect(unmatched.leadTimeForChanges?.count).toBe(3);
  });
});

describe("computeDora — joining a change to its deployment", () => {
  it("prefers the deployment of the pull request's own head commit over an earlier one after the merge", () => {
    const dora = computeDora(
      [deploy("other", "success", 5), deploy("head", "success", 3)],
      [{ url: "pr/1", headSha: "head", mergedAt: at(6) }],
      options
    );
    // head went live 3 d − 1 h ago: 6 − 3 d + 1 h = 3 d + 1 h, not the 1 d + 1 h "other" would give
    expect(dora.leadTimeForChanges?.medianMs).toBe(3 * DAY + HOUR);
    expect(dora.deploymentsWithoutChanges).toBe(1);
  });

  it("a deployment of the head commit from before the merge is not the one that shipped it", () => {
    const dora = computeDora(
      [deploy("head", "success", 8), deploy("after", "success", 5)],
      [{ url: "pr/1", headSha: "head", mergedAt: at(6) }],
      options
    );
    // 6 − 5 d + 1 h, not 0
    expect(dora.leadTimeForChanges?.medianMs).toBe(DAY + HOUR);
  });

  it("a change whose deployment went live before the window is not in it", () => {
    const dora = computeDora(
      [deploy("old", "success", 19), deploy("new", "success", 2)],
      [{ url: "pr/old", headSha: "old", mergedAt: at(20) }],
      options
    );
    expect(dora.leadTimeForChanges).toBeNull();
  });
});

describe("computeDora — edges", () => {
  it("nothing deployed answers nulls, not zeros", () => {
    const dora = computeDora([], [], options);
    expect(dora).toMatchObject({
      deployments: 0,
      deploymentsPerWeek: null,
      changeFailureRate: null,
      timeToRestore: null,
      leadTimeForChanges: null,
      unrestored: 0,
    });
    expect(JSON.stringify(dora)).not.toContain("NaN");
  });

  it("a failure nothing has fixed yet is counted as unrestored", () => {
    const dora = computeDora([deploy("a", "success", 5), deploy("b", "failure", 2)], [], options);
    expect(dora.timeToRestore).toBeNull();
    expect(dora.unrestored).toBe(1);
  });

  it("a failure before the window is neither counted nor restored inside it", () => {
    const dora = computeDora([deploy("old", "failure", 30), deploy("fix", "success", 0.5)], [], options);
    expect(dora.deployments).toBe(1);
    expect(dora.timeToRestore).toBeNull();
    expect(dora.unrestored).toBe(0);
  });

  it("says how many succeeded and how many failures were restored, and whether a cap cut the rows", () => {
    const dora = computeDora(
      [deploy("a", "success", 5), deploy("b", "failure", 4), deploy("c", "success", 3), deploy("d", "failure", 1)],
      [],
      { ...options, capped: true, lastError: "GitHub answered 403" }
    );
    expect(dora).toMatchObject({ successes: 2, restored: 1, unrestored: 1, capped: true, lastError: "GitHub answered 403" });
  });

  it("says until when a rate limit holds, and only while it does", () => {
    expect(computeDora([], [], { ...options, rateLimitedUntil: new Date(NOW + HOUR) }).rateLimitedUntil).toBe(new Date(NOW + HOUR).toISOString());
    expect(computeDora([], [], { ...options, rateLimitedUntil: new Date(NOW - HOUR) }).rateLimitedUntil).toBeNull();
  });
});
