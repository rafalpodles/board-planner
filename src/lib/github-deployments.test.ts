import { describe, it, expect, vi, beforeEach } from "vitest";

const { fetchDeployments, fetchDeploymentStatuses, deploymentFind, deploymentInsertMany, deploymentUpdateOne, projectUpdateOne } =
  vi.hoisted(() => ({
    fetchDeployments: vi.fn(),
    fetchDeploymentStatuses: vi.fn(),
    deploymentFind: vi.fn(),
    deploymentInsertMany: vi.fn(),
    deploymentUpdateOne: vi.fn(),
    projectUpdateOne: vi.fn(),
  }));

vi.mock("@/lib/encryption", () => ({ decryptSecret: (v: string) => `plain:${v}` }));
vi.mock("@/models/deployment", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/models/deployment")>()),
  Deployment: { find: deploymentFind, insertMany: deploymentInsertMany, updateOne: deploymentUpdateOne },
}));
vi.mock("@/models/project", () => ({ Project: { updateOne: projectUpdateOne } }));
vi.mock("@/lib/github", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/github")>()),
  fetchDeployments,
  fetchDeploymentStatuses,
}));

const { syncGithubDeployments, outcomeOf, STATUS_CHECKS_PER_TICK, DEPLOYMENT_PAGES_PER_TICK } = await import("./github-deployments");
const { GitHubRateLimited } = await import("@/lib/github");
const { scopedToDefaultOrganisation } = await import("@/lib/db-scope");
const db = scopedToDefaultOrganisation();

const NOW = new Date("2026-10-15T12:00:00Z");
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000).toISOString();
const deployment = (id: number, createdHoursAgo: number) => ({
  id,
  sha: `sha${id}`,
  ref: "main",
  environment: "production",
  created_at: hoursAgo(createdHoursAgo),
});
const project = (over: Record<string, unknown> = {}) => ({
  _id: "p1",
  repositoryUrl: "https://github.com/example/board",
  githubToken: "sealed",
  deploymentEnvironment: "production",
  deploymentSync: { syncedThrough: null, blockedUntil: null },
  ...over,
});

let known: { _id: string; githubId: number }[] = [];
let pending: { _id: string; githubId: number }[] = [];

beforeEach(() => {
  vi.clearAllMocks();
  known = [];
  pending = [];
  deploymentFind.mockImplementation((filter: Record<string, unknown>) => {
    const rows = filter.state === "pending" ? pending : known;
    const chain = { sort: () => chain, limit: () => chain, lean: () => Promise.resolve(rows) };
    return chain;
  });
  deploymentInsertMany.mockResolvedValue([]);
  deploymentUpdateOne.mockResolvedValue({ modifiedCount: 1 });
  projectUpdateOne.mockResolvedValue({ modifiedCount: 1 });
  fetchDeploymentStatuses.mockResolvedValue([]);
});

describe("outcomeOf", () => {
  it("takes the newest finished status, past an inactive one that only means superseded", () => {
    expect(
      outcomeOf([
        { state: "inactive", created_at: hoursAgo(1) },
        { state: "success", created_at: hoursAgo(2), environment_url: "https://app.example" },
        { state: "in_progress", created_at: hoursAgo(3) },
      ])
    ).toEqual({ state: "success", at: new Date(hoursAgo(2)), url: "https://app.example" });
  });

  it("has no outcome while the deployment is still running", () => {
    expect(outcomeOf([{ state: "in_progress", created_at: hoursAgo(1) }, { state: "queued", created_at: hoursAgo(2) }])).toBeNull();
  });
});

describe("syncGithubDeployments", () => {
  it("does nothing for a project that is not on GitHub or has no token", async () => {
    expect(await syncGithubDeployments(db, project({ repositoryUrl: "https://gitlab.com/a/b" }), NOW)).toMatchObject({ ran: false, reason: "not github" });
    expect(await syncGithubDeployments(db, project({ githubToken: "" }), NOW)).toMatchObject({ ran: false, reason: "not github" });
    expect(fetchDeployments).not.toHaveBeenCalled();
  });

  it("stays away from GitHub while a rate limit it was given has not reset", async () => {
    const blocked = project({ deploymentSync: { syncedThrough: null, blockedUntil: new Date(NOW.getTime() + 60_000) } });

    expect(await syncGithubDeployments(db, blocked, NOW)).toEqual({ ran: false, reason: "rate limited", requests: 0 });
    expect(fetchDeployments).not.toHaveBeenCalled();
  });

  it("stores each new deployment once, as pending, and moves the cursor to the newest", async () => {
    fetchDeployments.mockResolvedValueOnce([deployment(3, 1), deployment(2, 5), deployment(1, 9)]);
    known = [{ _id: "d1", githubId: 1 }];

    const result = await syncGithubDeployments(db, project(), NOW);

    expect(fetchDeployments).toHaveBeenCalledWith("example", "board", "plain:sealed", "production", 1);
    expect(deploymentInsertMany.mock.calls[0][0].map((d: { githubId: number }) => d.githubId)).toEqual([3, 2]);
    expect(deploymentInsertMany.mock.calls[0][0][0]).toMatchObject({ state: "pending", sha: "sha3", environment: "production", startedAt: new Date(hoursAgo(1)) });
    expect(projectUpdateOne.mock.calls[0][1]).toEqual({
      $set: { "deploymentSync.syncedThrough": new Date(hoursAgo(1)), "deploymentSync.blockedUntil": null },
    });
    expect(result).toMatchObject({ ran: true, inserted: 2, requests: 1 });
  });

  it("reads further pages on the first sync, up to the cap, and stops at the cursor after that", async () => {
    const full = (from: number) => Array.from({ length: 100 }, (_, i) => deployment(from + i, 10 + from + i));
    fetchDeployments.mockImplementation(async (_o, _r, _t, _e, page: number) => full(page * 100));

    await syncGithubDeployments(db, project(), NOW);
    expect(fetchDeployments).toHaveBeenCalledTimes(DEPLOYMENT_PAGES_PER_TICK);

    fetchDeployments.mockClear();
    const cursor = new Date(hoursAgo(10 + 150));
    await syncGithubDeployments(db, project({ deploymentSync: { syncedThrough: cursor, blockedUntil: null } }), NOW);
    expect(fetchDeployments).toHaveBeenCalledTimes(1);
  });

  it("keeps the cursor when nothing new was listed", async () => {
    const cursor = new Date(hoursAgo(3));
    fetchDeployments.mockResolvedValueOnce([]);

    await syncGithubDeployments(db, project({ deploymentSync: { syncedThrough: cursor, blockedUntil: null } }), NOW);

    expect(projectUpdateOne.mock.calls[0][1].$set["deploymentSync.syncedThrough"]).toEqual(cursor);
  });

  it("asks unfinished deployments for their outcome, newest first and at most the cap, and records a finished one", async () => {
    fetchDeployments.mockResolvedValueOnce([]);
    pending = [
      { _id: "d9", githubId: 9 },
      { _id: "d8", githubId: 8 },
    ];
    fetchDeploymentStatuses
      .mockResolvedValueOnce([{ state: "failure", created_at: hoursAgo(1), log_url: "https://ci.example/9" }])
      .mockResolvedValueOnce([{ state: "in_progress", created_at: hoursAgo(1) }]);

    const result = await syncGithubDeployments(db, project(), NOW);

    expect(fetchDeploymentStatuses.mock.calls.map((c) => c[3])).toEqual([9, 8]);
    expect(deploymentUpdateOne).toHaveBeenCalledTimes(1);
    expect(deploymentUpdateOne.mock.calls[0][0]).toMatchObject({ _id: "d9", state: "pending" });
    expect(deploymentUpdateOne.mock.calls[0][1]).toEqual({
      $set: { state: "failure", finishedAt: new Date(hoursAgo(1)), url: "https://ci.example/9" },
    });
    expect(result).toMatchObject({ ran: true, finished: 1, requests: 3 });
    const pendingQuery = deploymentFind.mock.calls.find(([f]) => f.state === "pending")![0];
    expect(pendingQuery.startedAt.$gte).toEqual(new Date(NOW.getTime() - 3 * 86_400_000));
    expect(STATUS_CHECKS_PER_TICK).toBe(10);
  });

  it("on a rate limit stores when to come back and stops", async () => {
    const until = new Date(NOW.getTime() + 600_000);
    fetchDeployments.mockRejectedValueOnce(new GitHubRateLimited("limited", until));

    const result = await syncGithubDeployments(db, project(), NOW);

    expect(result).toEqual({ ran: false, reason: "rate limited", requests: 1 });
    expect(projectUpdateOne.mock.calls[0][1]).toEqual({ $set: { "deploymentSync.blockedUntil": until } });
    expect(deploymentInsertMany).not.toHaveBeenCalled();
  });

  it("lets any other failure through, so the tick logs it", async () => {
    fetchDeployments.mockRejectedValueOnce(new Error("GitHub answered 500"));

    await expect(syncGithubDeployments(db, project(), NOW)).rejects.toThrow("GitHub answered 500");
    expect(projectUpdateOne).not.toHaveBeenCalled();
  });

  it("a deployment another sync stored first is not an error", async () => {
    fetchDeployments.mockResolvedValueOnce([deployment(5, 1)]);
    deploymentInsertMany.mockRejectedValueOnce(Object.assign(new Error("E11000"), { code: 11000 }));

    await expect(syncGithubDeployments(db, project(), NOW)).resolves.toMatchObject({ ran: true });
  });
});
