import mongoose from "mongoose";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { DEFAULT_ORGANISATION_ID } from "@/lib/organisation-field";

const getAuthUser = vi.fn();
const check = vi.fn();
const projectFindOne = vi.fn();
const projectFindOneAndUpdate = vi.fn();
const projectUpdateOne = vi.fn();
const deploymentDeleteMany = vi.fn();
const taskFind = vi.fn();
const taskDeleteMany = vi.fn();
const commentDeleteMany = vi.fn();
const activityLogDeleteMany = vi.fn();
const projectFindOneAndDelete = vi.fn();
const sprintDeleteMany = vi.fn();
const notificationDeleteMany = vi.fn();
const pmMessageDeleteMany = vi.fn();
const projectAuditLogDeleteMany = vi.fn();
const grantDeleteMany = vi.fn();
const dropProjectReferences = vi.fn();

const logInstanceAudit = vi.fn();
const logProjectAudit = vi.fn();
vi.mock("@/lib/instanceAudit", () => ({ logInstanceAudit }));
const modelKeyAvailability = vi.hoisted(() => vi.fn());
const refuseModel = vi.hoisted(() => vi.fn());
vi.mock("@/lib/model-keys", () => ({ modelKeyAvailability }));
vi.mock("@/lib/model-check", () => ({ refuseModel }));
vi.mock("@/lib/db", () => ({ connectDB: vi.fn() }));
vi.mock("@/lib/auth", () => ({
  getAuthUser,
  RateLimitError: class RateLimitError extends Error {},
}));
vi.mock("@/lib/grants", () => ({ check }));
vi.mock("@/lib/projectAudit", () => ({ logProjectAudit }));
// The schema's own casting is exercised by settings-audit.test.ts and the e2e; here the update is
// laid over the before-image as written
const writtenPopulate = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("@/lib/project-write-images", () => ({
  projectWriteImages: (before: Record<string, unknown>, updates: Record<string, unknown>) => {
    const after = JSON.parse(JSON.stringify(before));
    for (const [path, value] of Object.entries(updates)) {
      const keys = path.split(".");
      let node = after;
      for (const key of keys.slice(0, -1)) node = node[key] ??= {};
      node[keys[keys.length - 1]] = value;
    }
    return { before, after: { ...after, toObject: () => after, populate: writtenPopulate } };
  },
}));
vi.mock("@/lib/encryption", () => ({
  encryptSecret: (v: string) => `enc:${v}`,
  isEncryptionConfigured: () => true,
}));
vi.mock("@/lib/url-validation", () => ({ isAllowedMcpServerUrl: () => true }));
vi.mock("@/models/project", () => ({
  Project: {
    findOne: projectFindOne,
    findOneAndDelete: projectFindOneAndDelete,
    findOneAndUpdate: projectFindOneAndUpdate,
    updateOne: projectUpdateOne,
  },
}));
vi.mock("@/models/deployment", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/models/deployment")>()),
  Deployment: { deleteMany: deploymentDeleteMany },
}));
vi.mock("@/models/task", () => ({
  Task: {
    find: taskFind,
    deleteMany: taskDeleteMany,
  },
}));
vi.mock("@/models/comment", () => ({
  Comment: {
    deleteMany: commentDeleteMany,
  },
}));
vi.mock("@/models/activityLog", () => ({
  ActivityLog: {
    deleteMany: activityLogDeleteMany,
  },
}));
vi.mock("@/models/sprint", () => ({
  Sprint: { deleteMany: sprintDeleteMany },
}));
vi.mock("@/models/notification", () => ({
  Notification: { deleteMany: notificationDeleteMany },
}));
vi.mock("@/models/pmMessage", () => ({
  PmMessage: { deleteMany: pmMessageDeleteMany },
}));
vi.mock("@/models/projectAuditLog", () => ({
  ProjectAuditLog: { deleteMany: projectAuditLogDeleteMany },
}));
vi.mock("@/models/grant", () => ({
  Grant: { deleteMany: grantDeleteMany },
}));
vi.mock("@/lib/project-references", () => ({ dropProjectReferences }));
const plan = vi.hoisted(() => ({ value: "pro" as "free" | "pro" }));
vi.mock("@/lib/organisation", () => ({
  getOrganisation: async () => ({ _id: "t1", entitlements: { plan: plan.value, features: [] } }),
}));

const { scopedToDefaultOrganisation } = await import("@/lib/db-scope");
const { DELETE, GET, PUT } = await import("./route");

const OWNER = { _id: "u1", role: "member" };
const MEMBER = { _id: "u2", role: "member" };
const PROJECT_ID = "507f1f77bcf86cd799439011";

const numberFieldId = "6a70afff45d39cd9bc8bb501";
const textFieldId = "6a70afff45d39cd9bc8bb502";
const archivedNumberFieldId = "6a70afff45d39cd9bc8bb503";

const PROJECT_CUSTOM_FIELDS = [
  { _id: { toString: () => numberFieldId }, fieldType: "number", archived: false },
  { _id: { toString: () => textFieldId }, fieldType: "text", archived: false },
  { _id: { toString: () => archivedNumberFieldId }, fieldType: "number", archived: true },
];

function request() {
  return new Request("http://localhost/api/projects/p1", { method: "DELETE" });
}

function putRequest(body: unknown) {
  return new Request("http://localhost/api/projects/p1", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const ctx = () => ({ params: Promise.resolve({ projectId: PROJECT_ID }) });

const SAVED = { _id: PROJECT_ID, toObject: () => ({ _id: PROJECT_ID, name: "Test Project" }) };
const saved = () => Promise.resolve(SAVED);

beforeEach(() => {
  vi.clearAllMocks();
  modelKeyAvailability.mockResolvedValue({ available: true, needsPlan: false, unreadable: false });
  refuseModel.mockResolvedValue(null);
  plan.value = "pro";
  getAuthUser.mockResolvedValue(OWNER);
  projectFindOne.mockReturnValue({
    toObject: () => ({ _id: PROJECT_ID, name: "Test Project" }),
    select: () => Promise.resolve({ customFields: PROJECT_CUSTOM_FIELDS }),
    populate: saved,
  });
  projectFindOneAndUpdate.mockReturnValue({
    lean: () => Promise.resolve({ _id: PROJECT_ID, name: "Test Project" }),
  });
  taskFind.mockReturnValue({
    distinct: () => Promise.resolve([]),
  });
  projectFindOneAndDelete.mockResolvedValue({ _id: PROJECT_ID });
  deploymentDeleteMany.mockResolvedValue({ deletedCount: 0 });
  commentDeleteMany.mockResolvedValue({ deletedCount: 0 });
  activityLogDeleteMany.mockResolvedValue({ deletedCount: 0 });
  taskDeleteMany.mockResolvedValue({ deletedCount: 0 });
  sprintDeleteMany.mockResolvedValue({ deletedCount: 0 });
  notificationDeleteMany.mockResolvedValue({ deletedCount: 0 });
  pmMessageDeleteMany.mockResolvedValue({ deletedCount: 0 });
  projectAuditLogDeleteMany.mockResolvedValue({ deletedCount: 0 });
  grantDeleteMany.mockResolvedValue({ deletedCount: 0 });
});

describe("DELETE /api/projects/[projectId]", () => {
  it("allows a project owner to delete", async () => {
    check.mockResolvedValue(true);

    const response = await DELETE(request(), ctx());

    expect(response.status).toBe(200);
    expect(projectFindOneAndDelete).toHaveBeenCalledWith({ _id: PROJECT_ID, organisation: DEFAULT_ORGANISATION_ID });
  });

  it("denies a plain member from deleting", async () => {
    check.mockResolvedValue(false);
    getAuthUser.mockResolvedValue(MEMBER);

    const response = await DELETE(request(), ctx());

    expect(response.status).toBe(403);
    expect(projectFindOneAndDelete).not.toHaveBeenCalled();
    expect(grantDeleteMany).not.toHaveBeenCalled();
  });

  it("drops the grants on that project and no other", async () => {
    check.mockResolvedValue(true);

    const response = await DELETE(request(), ctx());

    expect(response.status).toBe(200);
    expect(grantDeleteMany).toHaveBeenCalledTimes(1);
    expect(grantDeleteMany).toHaveBeenCalledWith({ objectType: "project", object: PROJECT_ID, organisation: DEFAULT_ORGANISATION_ID });
  });

  it("drops the grants only once the project itself is gone", async () => {
    check.mockResolvedValue(true);

    await DELETE(request(), ctx());

    expect(grantDeleteMany.mock.invocationCallOrder[0]).toBeGreaterThan(
      projectFindOneAndDelete.mock.invocationCallOrder[0]
    );
  });

  it("keeps every grant and reference when the project does not exist", async () => {
    check.mockResolvedValue(true);
    projectFindOne.mockResolvedValueOnce(null);

    const response = await DELETE(request(), ctx());

    expect(response.status).toBe(404);
    expect(grantDeleteMany).not.toHaveBeenCalled();
    expect(dropProjectReferences).not.toHaveBeenCalled();
  });

  it("drops the project's deployments", async () => {
    check.mockResolvedValue(true);

    await DELETE(request(), ctx());

    expect(deploymentDeleteMany.mock.calls[0][0]).toMatchObject({ project: PROJECT_ID });
  });

  it("drops what other collections hold about the project, by the project's own id", async () => {
    check.mockResolvedValue(true);
    const _id = { toString: () => PROJECT_ID };
    projectFindOne.mockResolvedValueOnce({ _id });

    const response = await DELETE(request(), ctx());

    expect(response.status).toBe(200);
    expect(dropProjectReferences).toHaveBeenCalledTimes(1);
    expect(dropProjectReferences.mock.calls[0][1]).toBe(_id);
  });

  it("drops those references only once the project itself is gone", async () => {
    check.mockResolvedValue(true);

    await DELETE(request(), ctx());

    expect(dropProjectReferences.mock.invocationCallOrder[0]).toBeGreaterThan(
      projectFindOneAndDelete.mock.invocationCallOrder[0]
    );
  });

  it("leaves every reference alone when a member is refused", async () => {
    check.mockResolvedValue(false);
    getAuthUser.mockResolvedValue(MEMBER);

    await DELETE(request(), ctx());

    expect(dropProjectReferences).not.toHaveBeenCalled();
  });
});

// BP-411 made project keys immutable through this route; BP-415 found the guard written twice
// (the second copy dead — the first already returns) and neither copy pinned by a test. Deleting
// the *live* one by mistake would silently undo BP-411 with every check staying green.
describe("PUT /api/projects/[projectId] key immutability", () => {
  beforeEach(() => {
    check.mockResolvedValue(true);
  });

  it("refuses a request that changes the project key", async () => {
    const res = await PUT(putRequest({ key: "NEWKEY" }), ctx());

    expect(res.status).toBe(403);
    expect(projectFindOneAndUpdate).not.toHaveBeenCalled();
  });

  // Control: an ordinary field update must still go through, so the 403 above is about `key`
  // specifically and not the route refusing every PUT.
  it("still allows an ordinary name update", async () => {
    const res = await PUT(putRequest({ name: "Renamed" }), ctx());

    expect(res.status).toBe(200);
    expect(projectFindOneAndUpdate).toHaveBeenCalledWith(
      { _id: PROJECT_ID, organisation: DEFAULT_ORGANISATION_ID },
      expect.objectContaining({ name: "Renamed" }),
      expect.anything()
    );
  });
});

describe("PUT /api/projects/[projectId] deploymentEnvironment", () => {
  beforeEach(() => {
    check.mockResolvedValue(true);
    projectUpdateOne.mockResolvedValue({ modifiedCount: 1 });
  });

  const sent = () => projectFindOneAndUpdate.mock.calls[0][1] as Record<string, unknown>;

  it("stores a trimmed name and restarts the deployment cursor when it changes", async () => {
    const res = await PUT(putRequest({ deploymentEnvironment: "  live  " }), ctx());

    expect(res.status).toBe(200);
    expect(sent()).toMatchObject({ deploymentEnvironment: "live" });
    expect(projectUpdateOne.mock.calls[0][1]).toEqual({
      $set: { "deploymentSync.syncedThrough": null, "deploymentSync.lastError": "", "deploymentSync.blockedUntil": null },
    });
    expect(deploymentDeleteMany).not.toHaveBeenCalled();
  });

  it("an empty name means production again", async () => {
    await PUT(putRequest({ deploymentEnvironment: "" }), ctx());

    expect(sent()).toMatchObject({ deploymentEnvironment: "production" });
  });

  it("keeps the cursor when the name does not change", async () => {
    projectFindOneAndUpdate.mockReturnValue({
      lean: () => Promise.resolve({ _id: PROJECT_ID, name: "Test Project", deploymentEnvironment: "production" }),
    });

    await PUT(putRequest({ deploymentEnvironment: "production" }), ctx());

    expect(projectUpdateOne).not.toHaveBeenCalled();
  });

  it("refuses a name longer than GitHub would ever send", async () => {
    const res = await PUT(putRequest({ deploymentEnvironment: "x".repeat(256) }), ctx());

    expect(res.status).toBe(400);
    expect(projectFindOneAndUpdate).not.toHaveBeenCalled();
  });

  it("a repository that moves drops the old one's deployments and restarts the cursor", async () => {
    projectFindOneAndUpdate.mockReturnValue({
      lean: () => Promise.resolve({ _id: PROJECT_ID, name: "Test Project", repositoryUrl: "https://github.com/old/repo" }),
    });

    await PUT(putRequest({ repositoryUrl: "https://github.com/new/repo" }), ctx());

    expect(deploymentDeleteMany.mock.calls[0][0]).toMatchObject({ project: PROJECT_ID });
    expect(projectUpdateOne.mock.calls[0][1].$set["deploymentSync.syncedThrough"]).toBeNull();
  });

  it("the same repository written another way is not a move", async () => {
    projectFindOneAndUpdate.mockReturnValue({
      lean: () => Promise.resolve({ _id: PROJECT_ID, name: "Test Project", repositoryUrl: "https://github.com/Old/Repo" }),
    });

    await PUT(putRequest({ repositoryUrl: "https://github.com/old/repo/" }), ctx());

    expect(deploymentDeleteMany).not.toHaveBeenCalled();
    expect(projectUpdateOne).not.toHaveBeenCalled();
  });

  // BP-986: the list mirrors the address, and its primary keeps the id a task or machine names it by
  it("writes the primary repository's new address into the list, keeping its id", async () => {
    const primary = new mongoose.Types.ObjectId();
    projectFindOne.mockReturnValue({
      toObject: () => ({ _id: PROJECT_ID, name: "Test Project" }),
      select: () => Promise.resolve({ repositories: [{ _id: primary, url: "https://github.com/old/repo", name: "Web" }] }),
      populate: saved,
    });

    await PUT(putRequest({ repositoryUrl: "https://github.com/new/repo" }), ctx());

    expect(projectFindOneAndUpdate.mock.calls[0][1]).toMatchObject({
      repositoryUrl: "https://github.com/new/repo",
      repositories: [{ _id: primary, url: "https://github.com/new/repo", name: "Web" }],
    });
  });

  describe("additional repositories", () => {
    const primary = new mongoose.Types.ObjectId();
    const api = new mongoose.Types.ObjectId();
    const stored = [
      { _id: primary, url: "https://github.com/acme/web", name: "Web" },
      { _id: api, url: "https://github.com/acme/api", name: "API" },
    ];
    const listed = (repositories: typeof stored) =>
      projectFindOne.mockReturnValue({
        toObject: () => ({ _id: PROJECT_ID, name: "Test Project", repositories }),
        select: () => Promise.resolve({ repositories, repositoryUrl: repositories[0]?.url ?? "" }),
        populate: saved,
      });

    it("stores the entries after the primary, keeping the id of an address that was already listed", async () => {
      listed(stored);

      const res = await PUT(
        putRequest({ additionalRepositories: [{ url: " https://github.com/acme/api ", name: "Backend" }, { url: "https://github.com/acme/docs" }] }),
        ctx()
      );

      expect(res.status).toBe(200);
      const written = projectFindOneAndUpdate.mock.calls[0][1].repositories;
      expect(written).toHaveLength(3);
      expect(written[0]).toEqual(stored[0]);
      expect(written[1]).toEqual({ _id: api, url: "https://github.com/acme/api", name: "Backend" });
      expect(written[2]).toMatchObject({ url: "https://github.com/acme/docs", name: "" });
      expect(written[2]._id).toBeInstanceOf(mongoose.Types.ObjectId);
    });

    it("removes every extra entry when the list is empty, leaving the primary", async () => {
      listed(stored);

      await PUT(putRequest({ additionalRepositories: [] }), ctx());

      expect(projectFindOneAndUpdate.mock.calls[0][1].repositories).toEqual([stored[0]]);
    });

    it("writes the audit trail naming what was added, renamed and removed", async () => {
      listed(stored);
      projectFindOneAndUpdate.mockReturnValue({
        lean: () => Promise.resolve({ _id: PROJECT_ID, name: "Test Project", repositories: stored }),
      });
      logProjectAudit.mockClear();

      await PUT(putRequest({ additionalRepositories: [{ url: "https://github.com/acme/docs", name: "Docs" }] }), ctx());

      const said = logProjectAudit.mock.calls.flatMap(([, , , , detail]) => (Array.isArray(detail) ? detail : [String(detail)]));
      expect(said).toContain("Added repository https://github.com/acme/docs (Docs)");
      expect(said).toContain("Removed repository https://github.com/acme/api");
    });

    it.each([
      ["a list that is not a list", "nope", /must be a list/],
      ["more than ten repositories in all", Array.from({ length: 10 }, (_, i) => ({ url: `https://github.com/acme/r${i}` })), /at most 10/],
      ["an entry with no address", [{ url: "  " }], /address is empty/],
      ["an entry that is not an object", ["https://github.com/acme/api"], /must be an object/],
      ["an address that repeats the primary", [{ url: "https://github.com/ACME/web.git" }], /already listed/],
      ["an address listed twice", [{ url: "https://github.com/acme/api" }, { url: "git@github.com:acme/api.git" }], /already listed/],
      ["a name that runs to a second line", [{ url: "https://github.com/acme/api", name: "A\nB" }], /name must be at most/],
      ["an address with a control character", [{ url: "https://github.com/acme/api\u0000" }], /not a valid address/],
    ])("refuses %s", async (_label, additionalRepositories, error) => {
      listed(stored);

      const res = await PUT(putRequest({ additionalRepositories }), ctx());

      expect(res.status).toBe(400);
      expect((await res.json()).error).toMatch(error);
      expect(projectFindOneAndUpdate).not.toHaveBeenCalled();
    });

    it("refuses extras on a project that has no primary repository", async () => {
      listed([]);

      const res = await PUT(putRequest({ additionalRepositories: [{ url: "https://github.com/acme/api" }] }), ctx());

      expect(res.status).toBe(400);
      expect((await res.json()).error).toMatch(/set the repository URL/);
    });

    it("refuses to clear the primary address while others are listed, instead of promoting the next one", async () => {
      listed(stored);

      const res = await PUT(putRequest({ repositoryUrl: "" }), ctx());

      expect(res.status).toBe(400);
      expect((await res.json()).error).toMatch(/Remove the additional repositories/);
      expect(projectFindOneAndUpdate).not.toHaveBeenCalled();
    });

    it("refuses a new primary that is already one of the others, whether or not the others are sent", async () => {
      listed(stored);

      const res = await PUT(putRequest({ repositoryUrl: "https://github.com/acme/api" }), ctx());

      expect(res.status).toBe(400);
      expect((await res.json()).error).toMatch(/already listed/);
      expect(projectFindOneAndUpdate).not.toHaveBeenCalled();
    });

    it("clears the primary and the others in one request without promoting one of them", async () => {
      listed(stored);

      const res = await PUT(putRequest({ repositoryUrl: "", additionalRepositories: [] }), ctx());

      expect(res.status).toBe(200);
      expect(projectFindOneAndUpdate.mock.calls[0][1]).toMatchObject({ repositoryUrl: "", repositories: [] });
    });

    it("treats the same path on another host as a different repository: audited, and no longer the same id", async () => {
      listed(stored);
      projectFindOneAndUpdate.mockReturnValue({
        lean: () => Promise.resolve({ _id: PROJECT_ID, name: "Test Project", repositories: stored }),
      });
      logProjectAudit.mockClear();

      await PUT(putRequest({ additionalRepositories: [{ url: "https://git.example.com/acme/api", name: "API" }] }), ctx());

      const written = projectFindOneAndUpdate.mock.calls[0][1].repositories;
      expect(written[1].url).toBe("https://git.example.com/acme/api");
      expect(written[1]._id).not.toEqual(api);
      const said = logProjectAudit.mock.calls.flatMap(([, , , , detail]) => (Array.isArray(detail) ? detail : [String(detail)]));
      expect(said).toContain("Added repository https://git.example.com/acme/api (API)");
      expect(said).toContain("Removed repository https://github.com/acme/api");
    });

    it("writes the list only over the one it was worked out from", async () => {
      listed(stored);

      await PUT(putRequest({ additionalRepositories: [] }), ctx());

      const [filter] = projectFindOneAndUpdate.mock.calls[0];
      expect(filter.$expr).toEqual({ $eq: [{ $ifNull: ["$repositories", []] }, { $literal: stored }] });
    });

    it("answers 409 and stores nothing when somebody else changed the list in between", async () => {
      listed(stored);
      projectFindOneAndUpdate.mockReturnValueOnce({ lean: () => Promise.resolve(null) });
      projectFindOne.mockReturnValueOnce({
        toObject: () => ({}),
        select: () => Promise.resolve({ repositories: stored }),
      });
      projectFindOne.mockReturnValueOnce({
        select: () => ({ lean: () => Promise.resolve({ _id: PROJECT_ID, repositories: [stored[0]] }) }),
      });

      const res = await PUT(putRequest({ additionalRepositories: [] }), ctx());

      expect(res.status).toBe(409);
      expect((await res.json()).error).toMatch(/repositories changed while this was saved/);
      expect(projectFindOneAndUpdate).toHaveBeenCalledTimes(1);
    });

    it("lets the primary be replaced in the same request that lists the others", async () => {
      listed(stored);

      await PUT(putRequest({ repositoryUrl: "https://github.com/acme/web2", additionalRepositories: [{ url: "https://github.com/acme/api" }] }), ctx());

      const written = projectFindOneAndUpdate.mock.calls[0][1].repositories;
      expect(written.map((r: { url: string }) => r.url)).toEqual(["https://github.com/acme/web2", "https://github.com/acme/api"]);
      expect(written[0]._id).toEqual(primary);
    });
  });

  it("clears the list when the address is cleared", async () => {
    await PUT(putRequest({ repositoryUrl: "" }), ctx());
    expect(projectFindOneAndUpdate.mock.calls[0][1]).toMatchObject({ repositoryUrl: "", repositories: [] });
  });

  it("refuses an address longer than the list can store", async () => {
    const res = await PUT(putRequest({ repositoryUrl: `https://github.com/${"x".repeat(2048)}` }), ctx());

    expect(res.status).toBe(400);
    expect(projectFindOneAndUpdate).not.toHaveBeenCalled();
  });

  it("leaves the list alone when the address is not being written", async () => {
    await PUT(putRequest({ name: "Renamed" }), ctx());
    expect(projectFindOneAndUpdate.mock.calls[0][1]).not.toHaveProperty("repositories");
  });

  it("refuses a name that is not text", async () => {
    const res = await PUT(putRequest({ deploymentEnvironment: { $ne: "" } }), ctx());

    expect(res.status).toBe(400);
  });
});

describe("PUT /api/projects/[projectId] estimateFieldId", () => {
  beforeEach(() => {
    check.mockResolvedValue(true);
  });

  it("refuses a designation naming a field the project does not have", async () => {
    const res = await PUT(putRequest({ estimateFieldId: "6a70afff45d39cd9bc8bb5ff" }), ctx());

    expect(res.status).toBe(400);
    expect(projectFindOneAndUpdate).not.toHaveBeenCalled();
  });

  it("refuses a designation naming a field that is not numeric", async () => {
    const res = await PUT(putRequest({ estimateFieldId: textFieldId }), ctx());

    expect(res.status).toBe(400);
    expect(projectFindOneAndUpdate).not.toHaveBeenCalled();
  });

  it("refuses a designation naming an archived field", async () => {
    const res = await PUT(putRequest({ estimateFieldId: archivedNumberFieldId }), ctx());

    expect(res.status).toBe(400);
    expect(projectFindOneAndUpdate).not.toHaveBeenCalled();
  });

  it("refuses a non-string designation instead of coercing it", async () => {
    // String([]) === "" and String([numberFieldId]) === numberFieldId — either would have
    // slipped past a bare String(...) coercion instead of being refused.
    const res = await PUT(putRequest({ estimateFieldId: [] }), ctx());

    expect(res.status).toBe(400);
    expect(projectFindOneAndUpdate).not.toHaveBeenCalled();
  });

  it("refuses a non-string designation that would coerce to a real field id", async () => {
    const res = await PUT(putRequest({ estimateFieldId: [numberFieldId] }), ctx());

    expect(res.status).toBe(400);
    expect(projectFindOneAndUpdate).not.toHaveBeenCalled();
  });

  it("accepts an empty designation", async () => {
    const res = await PUT(putRequest({ estimateFieldId: "" }), ctx());

    expect(res.status).toBe(200);
    expect(projectFindOneAndUpdate).toHaveBeenCalledWith(
      { _id: PROJECT_ID, organisation: DEFAULT_ORGANISATION_ID },
      expect.objectContaining({ estimateFieldId: "" }),
      expect.anything()
    );
  });

  it("accepts a designation naming a numeric, non-archived field", async () => {
    const res = await PUT(putRequest({ estimateFieldId: numberFieldId }), ctx());

    expect(res.status).toBe(200);
    expect(projectFindOneAndUpdate).toHaveBeenCalledWith(
      { _id: PROJECT_ID, organisation: DEFAULT_ORGANISATION_ID },
      expect.objectContaining({ estimateFieldId: numberFieldId }),
      expect.anything()
    );
  });
});

// The clearing rule was pinned only in the helper's own unit tests, so deleting the whole block
// from this route left the suite green — the mutation the BP-315 review ran to prove it.
describe("PUT /api/projects/[projectId] and a repointed integration host", () => {
  function storedProject(overrides: Record<string, unknown> = {}) {
    return {
      gitlabHost: "https://gitlab.example.com",
      gitlabToken: "enc:v2:k:stored",
      codaHost: "https://coda.io",
      codaToken: "enc:v2:k:coda",
      ...overrides,
    };
  }

  function storedAs(project: Record<string, unknown>) {
    projectFindOne.mockReturnValue({
      lean: () => Promise.resolve(project),
      select: () => Promise.resolve({ customFields: PROJECT_CUSTOM_FIELDS }),
      toObject: () => ({ _id: PROJECT_ID, name: "Test Project" }),
      populate: saved,
    });
  }

  function updatesSentToMongo() {
    return projectFindOneAndUpdate.mock.calls[0][1] as Record<string, unknown>;
  }

  beforeEach(() => {
    check.mockResolvedValue(true);
    storedAs(storedProject());
  });

  it("clears the stored token when the host is repointed", async () => {
    const response = await PUT(
      putRequest({ gitlabHost: "https://collector.attacker.example" }),
      ctx()
    );

    expect(response.status).toBe(200);
    expect(updatesSentToMongo()).toMatchObject({
      gitlabHost: "https://collector.attacker.example",
      gitlabToken: "",
    });
  });

  it("keeps the token when a new one comes with the new host", async () => {
    await PUT(
      putRequest({ gitlabHost: "https://gitlab.other.example", gitlabToken: "glpat-fresh" }),
      ctx()
    );

    expect(updatesSentToMongo().gitlabToken).not.toBe("");
  });

  it("leaves the token alone when the host does not move", async () => {
    await PUT(putRequest({ gitlabHost: "https://gitlab.example.com/" }), ctx());

    expect(updatesSentToMongo()).not.toHaveProperty("gitlabToken");
  });

  // .lean() skips the schema default, and the form posts that default on every save
  it("does not clear the token when the stored host was never persisted", async () => {
    storedAs(storedProject({ gitlabHost: undefined }));

    await PUT(putRequest({ gitlabHost: "https://gitlab.com" }), ctx());

    expect(updatesSentToMongo()).not.toHaveProperty("gitlabToken");
  });

  it("records the clearing in the project audit trail as its own entry", async () => {
    await PUT(putRequest({ codaHost: "https://collector.attacker.example" }), ctx());

    expect(
      logProjectAudit.mock.calls.some(([, , , , detail]) => /Coda token cleared/.test(String(detail)))
    ).toBe(true);
  });
});

describe("PUT /api/projects/[projectId] and Coda on a free instance", () => {
  beforeEach(() => {
    check.mockResolvedValue(true);
    plan.value = "free";
    // A host in the body makes the route read the stored one, to clear a token it no longer fits
    projectFindOne.mockReturnValue({
      lean: () => Promise.resolve({ codaHost: "https://coda.io", codaToken: "enc:v2:k:coda" }),
      select: () => Promise.resolve({ customFields: PROJECT_CUSTOM_FIELDS }),
      toObject: () => ({ _id: PROJECT_ID, name: "Test Project" }),
      populate: saved,
    });
  });

  it.each([["codaDocId"], ["codaTableId"], ["codaHost"], ["codaToken"]])(
    "refuses a write naming %s with 402, writing nothing",
    async (field) => {
      const res = await PUT(putRequest({ name: "Renamed", [field]: "x" }), ctx());

      expect(res.status).toBe(402);
      expect(await res.json()).toMatchObject({ feature: "integrations.coda", plan: "free" });
      expect(projectFindOneAndUpdate).not.toHaveBeenCalled();
    }
  );

  it.each([
    ["Disconnect's payload", { codaDocId: "", codaTableId: "", codaHost: "https://coda.io", codaToken: "" }],
    ["an emptied token", { codaToken: "" }],
    ["a null token", { codaToken: null }],
    ["the default host with a trailing slash", { codaHost: "https://coda.io/" }],
  ])("lets %s through, since clearing Coda uses no Pro feature", async (_label, body) => {
    const res = await PUT(putRequest(body), ctx());

    expect(res.status).toBe(200);
  });

  it.each([
    ["a new host", { codaHost: "https://coda.example.com" }],
    ["a clear that also names a doc", { codaToken: "", codaDocId: "doc-2" }],
    ["a token of spaces", { codaToken: "   " }],
    ["a doc id of a slash", { codaDocId: "/" }],
  ])("still refuses %s", async (_label, body) => {
    const res = await PUT(putRequest(body), ctx());

    expect(res.status).toBe(402);
  });

  it("still saves everything else", async () => {
    const res = await PUT(putRequest({ name: "Renamed" }), ctx());

    expect(res.status).toBe(200);
    expect(projectFindOneAndUpdate).toHaveBeenCalled();
  });

  it("saves Coda again once the plan is Pro", async () => {
    plan.value = "pro";

    const res = await PUT(putRequest({ codaDocId: "doc-1" }), ctx());

    expect(res.status).toBe(200);
  });

  // BP-871: triage is Pro to turn on, and free to turn off
  it.each([["suggest"], ["auto"]])("refuses triage %s with 402, writing nothing", async (triageMode) => {
    const res = await PUT(putRequest({ triageMode }), ctx());

    expect(res.status).toBe(402);
    expect(await res.json()).toMatchObject({ feature: "ai.triage" });
    expect(projectFindOneAndUpdate).not.toHaveBeenCalled();
  });

  it("lets triage be turned off, and on once the plan is Pro, and refuses a mode that is not one", async () => {
    expect((await PUT(putRequest({ triageMode: "off" }), ctx())).status).toBe(200);
    expect((await PUT(putRequest({ triageMode: "always" }), ctx())).status).toBe(400);
    plan.value = "pro";
    expect((await PUT(putRequest({ triageMode: "auto" }), ctx())).status).toBe(200);
    expect(projectFindOneAndUpdate.mock.calls.at(-1)?.[1]).toMatchObject({ triageMode: "auto" });
  });
});

/**
 * A key reaches a task URL and from there Slack and Discord message markup (BP-401). The empty
 * string mattered most: the first version validated only a truthy, changed key, and
 * findByIdAndUpdate runs no validators, so `{"key":"  "}` erased the stored key — task keys
 * rendering as `-12`, and the old key never reaching formerKeys, which is what keeps existing
 * pull requests matching.
 */
describe("the key a project may be renamed to", () => {
  beforeEach(() => {
    check.mockResolvedValue(true);
    projectFindOne.mockReturnValue({
      toObject: () => ({ _id: PROJECT_ID }),
      select: () => Promise.resolve({ customFields: PROJECT_CUSTOM_FIELDS }),
      lean: () => Promise.resolve({ key: "TP", formerKeys: [] }),
      populate: saved,
    });
  });

  it.each([
    ["a Slack link closer", "A><HTTPS://PHISH.EXAMPLE|RESET"],
    ["a Discord heading", "A#URGENT"],
    ["the empty string", "   "],
    ["a number", 123],
    ["an array", ["A"]],
  ])("refuses %s, and writes nothing", async (_label, key) => {
    const res = await PUT(putRequest({ key }), ctx());

    expect(res.status).toBe(403);
    expect(projectFindOneAndUpdate).not.toHaveBeenCalled();
  });

  // Without this the refusals above would pass on a route that refuses every rename
  it("refuses a key change", async () => {
    const res = await PUT(putRequest({ key: " bp " }), ctx());

    expect(res.status).toBe(403);
    expect(projectFindOneAndUpdate).not.toHaveBeenCalled();
  });
});

// BP-736: the project's owner manages its worker settings; an instance admin keeps a lock that
// wins over them.
describe("PUT /api/projects/[projectId] worker settings", () => {
  const ADMIN = { _id: "a1", role: "admin" };

  // Both reads the route makes of it: the one its checks use, and the write's own before-image,
  // which is what the instance audit is decided from
  function stored(worker: Record<string, unknown>) {
    const project = { key: "TP", worker: { policyOverrides: [], ...worker } };
    projectFindOne.mockReturnValue({ select: () => Promise.resolve(project), populate: saved });
    projectFindOneAndUpdate.mockReturnValue({
      lean: () => Promise.resolve({ _id: PROJECT_ID, ...project }),
    });
  }

  function lastUpdate() {
    return projectFindOneAndUpdate.mock.calls.at(-1)?.[1] as Record<string, unknown> | undefined;
  }

  // Honours `need` and the caller, the way grants.check does: OWNER holds the owner grant, MEMBER
  // only the member one, and an instance admin passes everything
  beforeEach(() => {
    check.mockImplementation(async (_db: unknown, user: { _id: string; role: string }, _id: string, need: string) => {
      if (user.role === "admin") return true;
      if (user._id === OWNER._id) return true;
      return user._id === MEMBER._id && need === "access";
    });
    stored({ enabled: false });
  });

  it("lets the project's owner switch workers on, and records it for the instance", async () => {
    const response = await PUT(putRequest({ worker: { enabled: true } }), ctx());

    expect(response.status).toBe(200);
    expect(lastUpdate()).toMatchObject({ "worker.enabled": true });
    expect(logInstanceAudit).toHaveBeenCalledWith(
      scopedToDefaultOrganisation(),
      expect.objectContaining({ action: "project_workers_enabled", target: "TP", user: "u1" })
    );
  });

  it("lets the owner set the base branch and a timeout", async () => {
    const response = await PUT(
      putRequest({ worker: { policy: { baseBranch: "develop", taskTimeoutMs: 600000 } } }),
      ctx()
    );

    expect(response.status).toBe(200);
    expect(lastUpdate()).toMatchObject({
      "worker.policy.baseBranch": "develop",
      "worker.policy.taskTimeoutMs": 600000,
    });
  });

  it("refuses a member who does not own the project", async () => {
    getAuthUser.mockResolvedValue(MEMBER);

    const response = await PUT(putRequest({ worker: { enabled: true } }), ctx());

    expect(response.status).toBe(403);
    expect(projectFindOneAndUpdate).not.toHaveBeenCalled();
  });

  it("refuses the owner's machine credential", async () => {
    getAuthUser.mockResolvedValue({ ...OWNER, viaMachineCredential: true });

    const response = await PUT(putRequest({ worker: { enabled: true } }), ctx());

    expect(response.status).toBe(403);
    expect(projectFindOneAndUpdate).not.toHaveBeenCalled();
  });

  it("refuses the owner an enable while an admin's lock is on", async () => {
    stored({ enabled: false, lockedByInstance: true });

    const response = await PUT(putRequest({ worker: { enabled: true } }), ctx());

    expect(response.status).toBe(403);
    expect((await response.json()).error).toMatch(/locked workers off/);
    expect(projectFindOneAndUpdate).not.toHaveBeenCalled();
  });

  it("still lets the owner switch workers off under the lock", async () => {
    stored({ enabled: true, lockedByInstance: true });

    const response = await PUT(putRequest({ worker: { enabled: false } }), ctx());

    expect(response.status).toBe(200);
    expect(lastUpdate()).toMatchObject({ "worker.enabled": false });
  });

  it("refuses the owner the lock itself, in either direction", async () => {
    for (const lockedByInstance of [true, false]) {
      stored({ enabled: true, lockedByInstance: !lockedByInstance });

      const response = await PUT(putRequest({ worker: { lockedByInstance } }), ctx());

      expect(response.status).toBe(403);
    }
    expect(projectFindOneAndUpdate).not.toHaveBeenCalled();
  });

  it("lets an admin lock a project, and records it for the instance", async () => {
    getAuthUser.mockResolvedValue(ADMIN);
    stored({ enabled: true });

    const response = await PUT(putRequest({ worker: { lockedByInstance: true } }), ctx());

    expect(response.status).toBe(200);
    expect(lastUpdate()).toMatchObject({ "worker.lockedByInstance": true });
    expect(logInstanceAudit).toHaveBeenCalledWith(
      scopedToDefaultOrganisation(),
      expect.objectContaining({ action: "project_workers_locked", target: "TP" })
    );
  });

  it("lets an admin switch a locked project on, since the lock is theirs", async () => {
    getAuthUser.mockResolvedValue(ADMIN);
    stored({ enabled: false, lockedByInstance: true });

    const response = await PUT(putRequest({ worker: { enabled: true } }), ctx());

    expect(response.status).toBe(200);
    expect(lastUpdate()).toMatchObject({ "worker.enabled": true });
  });

  it("records an unlock for the instance", async () => {
    getAuthUser.mockResolvedValue(ADMIN);
    stored({ enabled: true, lockedByInstance: true });

    await PUT(putRequest({ worker: { lockedByInstance: false } }), ctx());

    expect(logInstanceAudit).toHaveBeenCalledWith(
      scopedToDefaultOrganisation(),
      expect.objectContaining({ action: "project_workers_unlocked", target: "TP" })
    );
  });

  it("records nothing when the lock is re-sent with the value it already has", async () => {
    getAuthUser.mockResolvedValue(ADMIN);
    stored({ enabled: true, lockedByInstance: true });

    const response = await PUT(putRequest({ worker: { lockedByInstance: true } }), ctx());

    expect(response.status).toBe(200);
    expect(logInstanceAudit).not.toHaveBeenCalled();
  });

  // The screen no longer offers these — they moved to the agent's blocks — but each still reaches
  // every machine serving the project as a fallback, so the owner must not set one through the API
  it.each(["model", "fallbackModel", "reviewModel", "maxDiffLines", "maxDiffFiles"])(
    "refuses the owner %s, a field that moved to the agent's blocks",
    async (field) => {
      const value = field.startsWith("maxDiff") ? 5 : "sonnet";

      const response = await PUT(putRequest({ worker: { policy: { [field]: value } } }), ctx());

      expect(response.status).toBe(403);
      expect((await response.json()).error).toContain(field);
      expect(projectFindOneAndUpdate).not.toHaveBeenCalled();
    }
  );

  it("lets the owner clear one of those fields back to the default", async () => {
    stored({ enabled: true, policyOverrides: ["model"] });

    const response = await PUT(putRequest({ worker: { reset: ["model"] } }), ctx());

    expect(response.status).toBe(200);
    expect(lastUpdate()).toMatchObject({ "worker.policy.model": "opus", "worker.policyOverrides": [] });
  });

  it("still lets an admin set one", async () => {
    getAuthUser.mockResolvedValue(ADMIN);

    const response = await PUT(putRequest({ worker: { policy: { model: "sonnet" } } }), ctx());

    expect(response.status).toBe(200);
    expect(lastUpdate()).toMatchObject({ "worker.policy.model": "sonnet" });
  });

  it("refuses an admin's API token the lock", async () => {
    getAuthUser.mockResolvedValue({ ...ADMIN, viaMachineCredential: true });

    const response = await PUT(putRequest({ worker: { lockedByInstance: true } }), ctx());

    expect(response.status).toBe(403);
  });
});

/**
 * BP-742. The trail named the fields a save touched and never their values, so it could not say
 * which repository machines were pointed at or whether runs were switched on. The before side is
 * the write's own before-image: a read taken earlier describes a document somebody else may have
 * changed since (BP-658).
 */
describe("PUT /api/projects/[projectId] audit trail", () => {
  function writtenOver(beforeImage: Record<string, unknown>) {
    projectFindOneAndUpdate.mockReturnValue({ lean: () => Promise.resolve(beforeImage) });
  }

  function auditDetails(): string[] {
    return logProjectAudit.mock.calls.map(([, , , , detail]) =>
      Array.isArray(detail) ? detail.join("\n") : String(detail)
    );
  }

  beforeEach(() => {
    check.mockResolvedValue(true);
  });

  it("records each changed setting with its value before and after", async () => {
    writtenOver({ name: "Orbit", repositoryUrl: "" });

    await PUT(
      putRequest({ name: "Orbit Two", repositoryUrl: "https://github.com/orbit-dev/orbit" }),
      ctx()
    );

    expect(auditDetails()).toEqual([
      "Name: Orbit → Orbit Two\nRepository: none → https://github.com/orbit-dev/orbit",
    ]);
  });

  it("writes no entry for a save that changed nothing", async () => {
    writtenOver({ name: "Orbit", description: "", icon: "" });

    const response = await PUT(putRequest({ name: "Orbit", description: "", icon: "" }), ctx());

    expect(response.status).toBe(200);
    expect(logProjectAudit).not.toHaveBeenCalled();
  });

  it("names a token without writing it", async () => {
    writtenOver({ githubToken: "" });

    await PUT(putRequest({ githubToken: "ghp_live_secret" }), ctx());

    expect(auditDetails()).toEqual(["GitHub token set"]);
    expect(auditDetails().join()).not.toContain("ghp_live_secret");
  });

  it("takes the value before from the write, not from the read that preceded it", async () => {
    getAuthUser.mockResolvedValue({ ...OWNER });
    projectFindOne.mockReturnValue({
      select: () => Promise.resolve({ key: "TP", worker: { enabled: false, policyOverrides: [] } }),
      populate: saved,
    });
    writtenOver({ key: "TP", worker: { enabled: true, policyOverrides: [] } });

    const response = await PUT(putRequest({ worker: { enabled: true } }), ctx());

    expect(response.status).toBe(200);
    expect(auditDetails()).toEqual([]);
  });

  // The write has landed by then, and a retry would find nothing left to record
  it("records the change even when what follows the write fails", async () => {
    writtenOver({ name: "Orbit" });
    writtenPopulate.mockRejectedValueOnce(new Error("the read gave up"));

    await PUT(putRequest({ name: "Orbit Two" }), ctx()).catch(() => undefined);

    expect(auditDetails()).toEqual(["Name: Orbit → Orbit Two"]);
  });

  // A client clearing a field with null keeps working, as it always did for the token fields
  it("reads null as clearing a field", async () => {
    writtenOver({ githubToken: "enc:old" });

    const res = await PUT(putRequest({ githubToken: null }), ctx());

    expect(res.status).toBe(200);
    expect(projectFindOneAndUpdate.mock.calls[0][1]).toMatchObject({ githubToken: "" });
    expect(auditDetails()).toEqual(["GitHub token cleared"]);
  });

  it("refuses a null name, which cannot be cleared", async () => {
    const res = await PUT(putRequest({ name: null }), ctx());

    expect(res.status).toBe(400);
    expect(projectFindOneAndUpdate).not.toHaveBeenCalled();
  });

  it("refuses a name left empty", async () => {
    const res = await PUT(putRequest({ name: "   " }), ctx());

    expect(res.status).toBe(400);
    expect(projectFindOneAndUpdate).not.toHaveBeenCalled();
  });

  // Mongoose casts an object to the string it carries, and only a string is encrypted: an object
  // token was stored in the clear, and logged as anything but set
  it.each(["githubToken", "repositoryUrl", "name"])("refuses %s that is not a string", async (field) => {
    const res = await PUT(putRequest({ [field]: { _id: "ghp_not_a_string" } }), ctx());

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: `${field} must be a string` });
    expect(projectFindOneAndUpdate).not.toHaveBeenCalled();
  });

  it("answers 404 when the project is gone by the time it is written", async () => {
    projectFindOneAndUpdate.mockReturnValue({ lean: () => Promise.resolve(null) });

    const response = await PUT(putRequest({ name: "Orbit Two" }), ctx());

    expect(response.status).toBe(404);
    expect(logProjectAudit).not.toHaveBeenCalled();
  });
});

// BP-786: a PM save used to $set the whole pm block from a read taken earlier in the request, so
// anything written in between (a refreshed OAuth token, the instance lock, the scheduler's slot)
// was put back the way the save had read it
describe("PUT /api/projects/[projectId] PM settings", () => {
  const ADMIN = { _id: "a1", role: "admin" };

  const oauthServer = (token: string) => ({
    _id: "s1",
    name: "linear",
    url: "https://mcp.linear.app/sse",
    authType: "oauth",
    authToken: "",
    allowWrites: false,
    toolAllowlist: [],
    enabled: true,
    oauth: {
      clientId: "c1",
      clientSecret: "",
      clientSource: "registered",
      authorizationEndpoint: "https://auth.linear.app/authorize",
      tokenEndpoint: "https://auth.linear.app/token",
      registrationEndpoint: "",
      redirectUri: "http://localhost/api/pm/oauth/callback",
      scopes: [],
      tokenAuthMethod: "none",
      accessToken: `enc:${token}`,
      refreshToken: `enc:${token}-refresh`,
      expiresAt: null,
      status: "connected",
    },
  });

  const autonomy = {
    dailyReview: true,
    reviewHour: 9,
    reviewIntervalHours: 24,
    timezone: "Europe/Warsaw",
    handleNeedsHumanReview: false,
  };

  const adminSave = {
    pm: {
      enabled: true,
      model: "",
      contextNotes: "notes",
      links: [],
      autonomy,
      mcpServers: [
        {
          name: "linear",
          url: "https://mcp.linear.app/sse",
          authType: "oauth",
          authToken: "",
          oauthClientId: "c1",
          oauthClientSecret: "",
          allowWrites: false,
          toolAllowlist: [],
          enabled: true,
        },
      ],
    },
  };

  // Each read of the project in turn: the route's own, then one per retry
  function reads(...pms: (Record<string, unknown> | null)[]) {
    for (const pm of pms) {
      projectFindOne.mockReturnValueOnce({
        select: () => ({ lean: () => Promise.resolve(pm && { _id: PROJECT_ID, pm }) }),
      });
    }
  }

  function writes(...befores: (Record<string, unknown> | null)[]) {
    for (const before of befores) {
      projectFindOneAndUpdate.mockReturnValueOnce({ lean: () => Promise.resolve(before) });
    }
  }

  const stored = (token: string) => ({
    enabled: true,
    lockedByInstance: true,
    mcpServers: [oauthServer(token)],
    autonomy: { ...autonomy, lastReviewSlot: "2026-09-26T09" },
  });

  it("writes the paths an owner sent, and never the lock or the scheduler's slot", async () => {
    getAuthUser.mockResolvedValue(OWNER);
    check.mockResolvedValue(true);
    reads(stored("old"));
    writes({ _id: PROJECT_ID, pm: stored("old") });

    const res = await PUT(putRequest({ pm: { contextNotes: "notes", links: [], autonomy } }), ctx());

    expect(res.status).toBe(200);
    const [filter, update] = projectFindOneAndUpdate.mock.calls[0];
    expect(filter).toEqual({ _id: PROJECT_ID, organisation: DEFAULT_ORGANISATION_ID });
    expect(Object.keys(update).sort()).toEqual([
      "pm.autonomy.dailyReview",
      "pm.autonomy.handleNeedsHumanReview",
      "pm.autonomy.reviewHour",
      "pm.autonomy.reviewIntervalHours",
      "pm.autonomy.timezone",
      "pm.contextNotes",
      "pm.links",
    ]);
  });

  it.each([
    ["the switch", { enabled: true }],
    ["the model", { model: "x/y" }],
    ["the MCP connections", { mcpServers: [] }],
  ])("refuses a project owner who is not an admin %s, which are the instance's", async (_name, pm) => {
    getAuthUser.mockResolvedValue(OWNER);
    check.mockResolvedValue(true);
    reads(stored("old"));

    const res = await PUT(putRequest({ pm }), ctx());

    expect(res.status).toBe(403);
    expect((await res.json()).error).toMatch(/Only an admin can change PM/);
    expect(projectFindOneAndUpdate).not.toHaveBeenCalled();
  });

  // BP-1024
  it("refuses a PM model the key in use cannot run, with the reason, and writes nothing", async () => {
    getAuthUser.mockResolvedValue(ADMIN);
    refuseModel.mockResolvedValue("The model x/y is not available on Board Planner's AI key.");
    reads(stored("old"));

    const res = await PUT(putRequest({ pm: { ...adminSave.pm, model: "x/y" } }), ctx());

    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("The model x/y is not available on Board Planner's AI key.");
    expect(refuseModel).toHaveBeenCalledWith(expect.anything(), "x/y");
    expect(projectFindOneAndUpdate).not.toHaveBeenCalled();
  });

  it("does not judge a model that is not changing, so a model stored earlier does not stop an unrelated save", async () => {
    getAuthUser.mockResolvedValue(ADMIN);
    refuseModel.mockResolvedValue("refused");
    reads({ ...stored("old"), model: "x/y" });
    writes({ _id: PROJECT_ID, pm: { ...stored("old"), model: "x/y" } });

    const res = await PUT(putRequest({ pm: { ...adminSave.pm, model: " x/y " } }), ctx());

    expect(res.status).toBe(200);
    expect(refuseModel).not.toHaveBeenCalled();
  });

  it("takes nothing from a turn or token cap that an older client still sends, and does not refuse the save for it", async () => {
    getAuthUser.mockResolvedValue(OWNER);
    check.mockResolvedValue(true);
    reads(stored("old"));
    writes({ _id: PROJECT_ID, pm: stored("old") });

    const res = await PUT(putRequest({ pm: { contextNotes: "notes", dailyTurnCap: 5, dailyTokenCap: 9 } }), ctx());

    expect(res.status).toBe(200);
    const [, update] = projectFindOneAndUpdate.mock.calls[0];
    expect(Object.keys(update)).toEqual(["pm.contextNotes"]);
  });

  it("writes the MCP list only over the list it merged the tokens from", async () => {
    getAuthUser.mockResolvedValue(ADMIN);
    reads(stored("old"));
    writes({ _id: PROJECT_ID, pm: stored("old") });

    const res = await PUT(putRequest(adminSave), ctx());

    expect(res.status).toBe(200);
    const [filter, update] = projectFindOneAndUpdate.mock.calls[0];
    expect(filter).toEqual({
      _id: PROJECT_ID,
      $expr: { $eq: [{ $ifNull: ["$pm.mcpServers", []] }, { $literal: [oauthServer("old")] }] },
      organisation: DEFAULT_ORGANISATION_ID,
    });
    expect(update).not.toHaveProperty("pm.lockedByInstance");
    expect(update).not.toHaveProperty("pm");
    expect(update["pm.mcpServers"][0].oauth.accessToken).toBe("enc:old");
  });

  it("keeps a token refreshed between its read and its write", async () => {
    getAuthUser.mockResolvedValue(ADMIN);
    reads(stored("old"), stored("refreshed"));
    writes(null, { _id: PROJECT_ID, pm: stored("refreshed") });

    const res = await PUT(putRequest(adminSave), ctx());

    expect(res.status).toBe(200);
    expect(projectFindOneAndUpdate).toHaveBeenCalledTimes(2);
    const [filter, update] = projectFindOneAndUpdate.mock.calls[1];
    expect(filter.$expr.$eq[1]).toEqual({ $literal: [oauthServer("refreshed")] });
    expect(update["pm.mcpServers"][0].oauth).toMatchObject({
      accessToken: "enc:refreshed",
      refreshToken: "enc:refreshed-refresh",
    });
  });

  it("gives up with a conflict when the list keeps changing, and records nothing", async () => {
    getAuthUser.mockResolvedValue(ADMIN);
    reads(stored("a"), stored("b"), stored("c"), stored("d"));
    writes(null, null, null);

    const res = await PUT(putRequest(adminSave), ctx());

    expect(res.status).toBe(409);
    expect(projectFindOneAndUpdate).toHaveBeenCalledTimes(3);
    expect(logProjectAudit).not.toHaveBeenCalled();
  });

  it("answers 404 when the project is gone by the time it retries", async () => {
    getAuthUser.mockResolvedValue(ADMIN);
    reads(stored("old"), null);
    writes(null);

    const res = await PUT(putRequest(adminSave), ctx());

    expect(res.status).toBe(404);
  });
});

// BP-739: the settings field classifies a draft URL in the browser, which cannot read this
// instance's GITHUB_API_BASE_URL, so both answers carry the GitHub origin it derives
// BP-652: what the PM screens draw depends on whether a call would run, and why not
describe("the project answer says whether the PM agent can run", () => {
  beforeEach(() => {
    check.mockResolvedValue(true);
  });

  it.each([
    ["with a key", { available: true, needsPlan: false, unreadable: false }, { pmAvailable: true, pmNeedsPlan: false, pmKeyUnreadable: false }],
    ["when only a plan would turn it on", { available: false, needsPlan: true, unreadable: false }, { pmAvailable: false, pmNeedsPlan: true, pmKeyUnreadable: false }],
    ["when the stored key cannot be read", { available: false, needsPlan: false, unreadable: true }, { pmAvailable: false, pmNeedsPlan: false, pmKeyUnreadable: true }],
    ["when the operator has switched its key off", { available: false, needsPlan: false, unreadable: false, locked: true }, { pmAvailable: false, pmLocked: true, pmNeedsPlan: false }],
  ])("on a read, %s", async (_case, availability, expected) => {
    modelKeyAvailability.mockResolvedValue(availability);

    const res = await GET(new Request("http://localhost/api/projects/p1"), ctx());

    expect(await res.json()).toMatchObject(expected);
    expect(modelKeyAvailability).toHaveBeenCalledWith(expect.anything());
  });

  it("on a save, too", async () => {
    modelKeyAvailability.mockResolvedValue({ available: false, needsPlan: true, unreadable: false });

    const res = await PUT(putRequest({ name: "Renamed" }), ctx());

    expect(await res.json()).toMatchObject({ pmAvailable: false, pmNeedsPlan: true });
  });

  it("on a save, the operator's lock too", async () => {
    modelKeyAvailability.mockResolvedValue({ available: false, needsPlan: false, unreadable: false, locked: true });

    const res = await PUT(putRequest({ name: "Renamed" }), ctx());

    expect(await res.json()).toMatchObject({ pmAvailable: false, pmLocked: true });
  });

  it("answers the project, and leaves the three fields out, when the key cannot be looked up", async () => {
    modelKeyAvailability.mockRejectedValue(new Error("database blip"));

    const res = await GET(new Request("http://localhost/api/projects/p1"), ctx());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toMatchObject({ name: "Test Project" });
    for (const field of ["pmAvailable", "pmNeedsPlan", "pmKeyUnreadable", "pmLocked"]) expect(body).not.toHaveProperty(field);
  });

  it("saves, and answers the project without the three fields, when the key cannot be looked up", async () => {
    modelKeyAvailability.mockRejectedValue(new Error("database blip"));

    const res = await PUT(putRequest({ name: "Renamed" }), ctx());
    const body = await res.json();

    expect(res.status).toBe(200);
    for (const field of ["pmAvailable", "pmNeedsPlan", "pmKeyUnreadable", "pmLocked"]) expect(body).not.toHaveProperty(field);
  });
});

describe("the project answer names this instance's GitHub", () => {
  beforeEach(() => {
    check.mockResolvedValue(true);
    vi.stubEnv("GITHUB_API_BASE_URL", "https://ghe.corp.example/api/v3");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("on a read", async () => {
    const res = await GET(new Request("http://localhost/api/projects/p1"), ctx());

    expect(res.status).toBe(200);
    expect((await res.json()).githubWebBase).toBe("https://ghe.corp.example");
  });

  it("on a save", async () => {
    const res = await PUT(putRequest({ name: "Renamed" }), ctx());

    expect(res.status).toBe(200);
    expect((await res.json()).githubWebBase).toBe("https://ghe.corp.example");
  });
});

// BP-862. Which groups give which role is the owners' to read, on their own route
describe("the project answer leaves out the group mapping", () => {
  it("for every reader, since a member, a worker and a connector can all read the board", async () => {
    check.mockResolvedValue(true);
    projectFindOne.mockReturnValue({
      toObject: () => ({ _id: PROJECT_ID, name: "Test Project", groupRoleMap: [{ group: "staff", role: "member" }] }),
      populate: () => Promise.resolve({ _id: PROJECT_ID, toObject: () => ({ _id: PROJECT_ID, name: "Test Project", groupRoleMap: [{ group: "staff", role: "member" }] }) }),
    });

    const body = await (await GET(new Request("http://localhost/api/projects/p1"), ctx())).json();

    expect(body.name).toBe("Test Project");
    expect(body).not.toHaveProperty("groupRoleMap");
  });
});
