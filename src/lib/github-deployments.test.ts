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

const { syncGithubDeployments, outcomeOf, STATUS_CHECKS_PER_TICK, DEPLOYMENT_PAGES_PER_TICK, REFUSED_RETRY_MS } = await import(
  "./github-deployments"
);
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
let pendingSort: unknown = null;

beforeEach(() => {
  vi.clearAllMocks();
  known = [];
  pending = [];
  pendingSort = null;
  deploymentFind.mockImplementation((filter: Record<string, unknown>) => {
    const isPending = filter.state === "pending";
    const rows = isPending ? pending : known;
    const chain = {
      sort: (order: unknown) => {
        if (isPending) pendingSort = order;
        return chain;
      },
      limit: () => chain,
      lean: () => Promise.resolve(rows),
    };
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
    expect(projectUpdateOne.mock.calls[0][0]).toMatchObject({
      _id: "p1",
      deploymentEnvironment: "production",
      repositoryUrl: "https://github.com/example/board",
    });
    expect(projectUpdateOne.mock.calls[0][1]).toEqual({
      $set: {
        "deploymentSync.syncedThrough": new Date(hoursAgo(1)),
        "deploymentSync.blockedUntil": null,
        "deploymentSync.lastError": "",
      },
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

  it("asks unfinished deployments for their outcome, never-asked first, at most the cap, and records what it learnt", async () => {
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
    expect(deploymentUpdateOne.mock.calls[0][0]).toMatchObject({ _id: "d9", state: "pending" });
    expect(deploymentUpdateOne.mock.calls[0][1]).toEqual({
      $set: { state: "failure", finishedAt: new Date(hoursAgo(1)), url: "https://ci.example/9", lastCheckedAt: NOW },
    });
    expect(deploymentUpdateOne.mock.calls[1][1]).toEqual({ $set: { lastCheckedAt: NOW } });
    expect(result).toMatchObject({ ran: true, finished: 1, requests: 3 });
    const pendingQuery = deploymentFind.mock.calls.find(([f]) => f.state === "pending")![0];
    expect(pendingQuery.$or).toEqual([
      { lastCheckedAt: null },
      { startedAt: { $gte: new Date(NOW.getTime() - 3 * 86_400_000) } },
    ]);
    expect(pendingQuery.environment).toBe("production");
    expect(pendingSort).toEqual({ lastCheckedAt: 1, startedAt: -1 });
    expect(STATUS_CHECKS_PER_TICK).toBe(10);
  });

  it("on a rate limit stores when to come back and stops", async () => {
    const until = new Date(NOW.getTime() + 600_000);
    fetchDeployments.mockRejectedValueOnce(new GitHubRateLimited("limited", until));

    const result = await syncGithubDeployments(db, project(), NOW);

    expect(result).toEqual({ ran: false, reason: "rate limited", requests: 1 });
    expect(projectUpdateOne.mock.calls[0][1]).toEqual({
      $set: { "deploymentSync.blockedUntil": until, "deploymentSync.lastError": "" },
    });
    expect(deploymentInsertMany).not.toHaveBeenCalled();
  });

  it("a listing GitHub refuses is kept as the reason, waits an hour, and is let through so the tick logs it", async () => {
    fetchDeployments.mockRejectedValueOnce(new Error("GitHub answered 403"));

    await expect(syncGithubDeployments(db, project(), NOW)).rejects.toThrow("GitHub answered 403");
    expect(projectUpdateOne.mock.calls[0][1]).toEqual({
      $set: {
        "deploymentSync.lastError": "GitHub answered 403",
        "deploymentSync.blockedUntil": new Date(NOW.getTime() + REFUSED_RETRY_MS),
      },
    });
  });

  it("a person pressing Sync may ask again after a refusal, but never past a rate limit", async () => {
    const later = new Date(NOW.getTime() + 600_000);
    const refused = project({ deploymentSync: { syncedThrough: null, blockedUntil: later, lastError: "GitHub answered 403" } });
    const limited = project({ deploymentSync: { syncedThrough: null, blockedUntil: later, lastError: "" } });
    fetchDeployments.mockResolvedValue([]);

    expect(await syncGithubDeployments(db, refused, NOW)).toMatchObject({ ran: false, reason: "refused" });
    expect(await syncGithubDeployments(db, limited, NOW, { askedByPerson: true })).toMatchObject({ ran: false, reason: "rate limited" });
    expect(fetchDeployments).not.toHaveBeenCalled();
    expect(await syncGithubDeployments(db, refused, NOW, { askedByPerson: true })).toMatchObject({ ran: true });
  });

  it("one deployment GitHub will not describe does not stop the others, and is not asked again soon", async () => {
    fetchDeployments.mockResolvedValueOnce([]);
    pending = [
      { _id: "d9", githubId: 9 },
      { _id: "d8", githubId: 8 },
    ];
    vi.spyOn(console, "warn").mockImplementation(() => {});
    fetchDeploymentStatuses
      .mockRejectedValueOnce(new Error("GitHub answered 404"))
      .mockResolvedValueOnce([{ state: "success", created_at: hoursAgo(1) }]);

    const result = await syncGithubDeployments(db, project(), NOW);

    expect(result).toMatchObject({ ran: true, finished: 1 });
    expect(deploymentUpdateOne.mock.calls[0][1]).toEqual({ $set: { lastCheckedAt: NOW } });
  });

  it("a rate limit while asking for outcomes still stops the pass", async () => {
    fetchDeployments.mockResolvedValueOnce([]);
    pending = [{ _id: "d9", githubId: 9 }];
    fetchDeploymentStatuses.mockRejectedValueOnce(new GitHubRateLimited("limited", new Date(NOW.getTime() + 60_000)));

    expect(await syncGithubDeployments(db, project(), NOW)).toMatchObject({ ran: false, reason: "rate limited" });
    expect(deploymentUpdateOne).not.toHaveBeenCalled();
  });

  it("a write that failed for any reason but a duplicate keeps the cursor where it was", async () => {
    fetchDeployments.mockResolvedValueOnce([deployment(5, 1)]);
    deploymentInsertMany.mockRejectedValueOnce(
      Object.assign(new Error("bulk"), { writeErrors: [{ code: 11000 }, { code: 121 }] })
    );

    await expect(syncGithubDeployments(db, project(), NOW)).rejects.toThrow("bulk");
    expect(projectUpdateOne.mock.calls.every(([, update]) => !("deploymentSync.syncedThrough" in update.$set))).toBe(true);
  });

  it("a deployment another sync stored first is not an error", async () => {
    fetchDeployments.mockResolvedValueOnce([deployment(5, 1)]);
    deploymentInsertMany.mockRejectedValueOnce(Object.assign(new Error("E11000"), { code: 11000 }));

    await expect(syncGithubDeployments(db, project(), NOW)).resolves.toMatchObject({ ran: true });
  });
});
