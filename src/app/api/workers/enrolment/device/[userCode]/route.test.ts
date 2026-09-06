import { describe, it, expect, vi, beforeEach } from "vitest";

const getAuthUser = vi.fn();
const check = vi.fn();
const accessibleProjectIds = vi.fn();
const findPendingByUserCode = vi.fn();
const projectFind = vi.fn();
const projectLean = vi.fn();
const workerFindOne = vi.fn();

vi.mock("@/lib/db", () => ({ connectDB: vi.fn() }));
vi.mock("@/lib/auth", () => ({
  getAuthUser,
  RateLimitError: class RateLimitError extends Error {},
}));
vi.mock("@/lib/grants", () => ({ check, accessibleProjectIds }));
vi.mock("@/lib/device-enrolment", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/device-enrolment")>();
  return { ...actual, findPendingByUserCode };
});
vi.mock("@/models/project", () => ({
  Project: {
    find: (...args: unknown[]) => {
      projectFind(...args);
      return { select: () => ({ lean: projectLean }) };
    },
  },
}));
vi.mock("@/models/worker", () => ({
  Worker: { findOne: () => ({ select: workerFindOne }) },
}));
vi.mock("@/lib/repository", () => ({
  projectRepositoryUrl: (p: { repositoryUrl?: string; githubRepo?: string }) =>
    p.repositoryUrl || (p.githubRepo ? `git@github.com:${p.githubRepo}.git` : ""),
}));

const { GET } = await import("./route");

const MEMBER = { _id: "member-1", role: "member", fullName: "Rafal", username: "rpo" };
const MINE = "69a52e3b399b27d3cbb2c5a5";
const THEIRS = "69a52e3b399b27d3cbb2c5b7";

function ctx(userCode = "ABCD-1234") {
  return { params: Promise.resolve({ userCode }) };
}

const request = () =>
  new Request("http://localhost/api/workers/enrolment/device/ABCD-1234");

beforeEach(() => {
  vi.clearAllMocks();
  getAuthUser.mockResolvedValue(MEMBER);
  check.mockResolvedValue(false);
  accessibleProjectIds.mockResolvedValue([MINE]);
  findPendingByUserCode.mockResolvedValue({
    _id: "enr-1",
    userCode: "ABCD1234",
    machineName: "rig-laptop",
    machineHost: "mac.home",
    status: "pending",
    expiresAt: new Date("2026-08-17T12:15:00.000Z"),
  });
  projectLean.mockResolvedValue([
    { _id: MINE, name: "Mine", key: "BP", repositoryUrl: "git@github.com:owner/repo.git", worker: { enabled: true } },
  ]);
  workerFindOne.mockResolvedValue(null);
});

describe("GET /api/workers/enrolment/device/:userCode", () => {
  it("answers for an ordinary member", async () => {
    const response = await GET(request(), ctx());

    expect(response.status).toBe(200);
    expect((await response.json()).machineName).toBe("rig-laptop");
  });

  it("asks only for the projects this person can reach", async () => {
    const response = await GET(request(), ctx());

    expect(accessibleProjectIds).toHaveBeenCalledWith(expect.objectContaining({ _id: "member-1" }));
    expect(projectFind).toHaveBeenCalledWith({ _id: { $in: [MINE] } });
    expect((await response.json()).projects.map((p: { _id: string }) => p._id)).toEqual([MINE]);
    expect(JSON.stringify(await GET(request(), ctx()).then((r) => r.json()))).not.toContain(THEIRS);
  });

  it("asks for every project when the person is under no restriction", async () => {
    accessibleProjectIds.mockResolvedValue(null);

    await GET(request(), ctx());

    expect(projectFind).toHaveBeenCalledWith({});
  });

  it("says an instance admin could turn machines on", async () => {
    getAuthUser.mockResolvedValue({ ...MEMBER, role: "admin" });

    const json = await (await GET(request(), ctx())).json();

    expect(json.projects[0]).toMatchObject({ workersEnabled: true, canEnable: true });
  });

  it("reports a project with machines switched off as switched off", async () => {
    projectLean.mockResolvedValue([
      { _id: MINE, name: "Mine", key: "BP", repositoryUrl: "git@github.com:owner/repo.git", worker: { enabled: false } },
    ]);

    expect((await (await GET(request(), ctx())).json()).projects[0].workersEnabled).toBe(false);
  });

  it("reports a project that has never had one as switched off, not undefined", async () => {
    projectLean.mockResolvedValue([
      { _id: MINE, name: "Mine", key: "BP", repositoryUrl: "git@github.com:owner/repo.git" },
    ]);

    expect((await (await GET(request(), ctx())).json()).projects[0].workersEnabled).toBe(false);
  });

  it("reports canEnable false for a member, whatever grants they hold", async () => {
    check.mockResolvedValue(true);

    const json = await (await GET(request(), ctx())).json();

    expect(json.projects[0].canEnable).toBe(false);
  });

  describe("a machine of this name that is already enrolled", () => {
    it("says only whether it is claimable, never who has it", async () => {
      workerFindOne.mockResolvedValue({ _id: "w1", owner: "somebody-else" });

      const json = await (await GET(request(), ctx())).json();

      expect(json.existingWorker).toEqual({ mine: false });
      expect(JSON.stringify(json)).not.toContain("somebody-else");
    });

    it("reports one of this person's own as theirs", async () => {
      workerFindOne.mockResolvedValue({ _id: "w1", owner: "member-1" });

      expect((await (await GET(request(), ctx())).json()).existingWorker).toEqual({ mine: true });
    });

    it("reports one nobody owns as claimable", async () => {
      workerFindOne.mockResolvedValue({ _id: "w1", owner: null });

      expect((await (await GET(request(), ctx())).json()).existingWorker).toEqual({ mine: true });
    });

    it("reports nothing at all when no such machine exists", async () => {
      expect((await (await GET(request(), ctx())).json()).existingWorker).toBeNull();
    });
  });

  it("judges a repository the way the confirmation does", async () => {
    projectLean.mockResolvedValue([
      { _id: MINE, name: "Legacy", key: "BP", githubRepo: "owner/repo", worker: { enabled: true } },
    ]);

    const json = await (await GET(request(), ctx())).json();

    expect(json.projects[0].repositoryUrl).toBe("git@github.com:owner/repo.git");
  });

  it("still refuses a machine credential", async () => {
    getAuthUser.mockResolvedValue({ ...MEMBER, viaMachineCredential: true });

    expect((await GET(request(), ctx())).status).toBe(403);
  });

  it("answers 404 for a code that has expired or been used", async () => {
    findPendingByUserCode.mockResolvedValue(null);

    expect((await GET(request(), ctx())).status).toBe(404);
  });
});
