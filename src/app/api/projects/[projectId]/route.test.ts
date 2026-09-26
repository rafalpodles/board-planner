import { describe, it, expect, vi, beforeEach } from "vitest";

const getAuthUser = vi.fn();
const check = vi.fn();
const projectFindById = vi.fn();
const projectFindByIdAndUpdate = vi.fn();
const taskFind = vi.fn();
const taskDeleteMany = vi.fn();
const commentDeleteMany = vi.fn();
const activityLogDeleteMany = vi.fn();
const projectFindByIdAndDelete = vi.fn();
const sprintDeleteMany = vi.fn();
const notificationDeleteMany = vi.fn();
const pmMessageDeleteMany = vi.fn();
const projectAuditLogDeleteMany = vi.fn();

const logInstanceAudit = vi.fn();
const logProjectAudit = vi.fn();
vi.mock("@/lib/instanceAudit", () => ({ logInstanceAudit }));
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
    findById: projectFindById,
    findByIdAndDelete: projectFindByIdAndDelete,
    findByIdAndUpdate: projectFindByIdAndUpdate,
  },
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

const { DELETE, PUT } = await import("./route");

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
  getAuthUser.mockResolvedValue(OWNER);
  projectFindById.mockReturnValue({
    toObject: () => ({ _id: PROJECT_ID, name: "Test Project" }),
    select: () => Promise.resolve({ customFields: PROJECT_CUSTOM_FIELDS }),
    populate: saved,
  });
  projectFindByIdAndUpdate.mockReturnValue({
    lean: () => Promise.resolve({ _id: PROJECT_ID, name: "Test Project" }),
  });
  taskFind.mockReturnValue({
    distinct: () => Promise.resolve([]),
  });
  projectFindByIdAndDelete.mockResolvedValue({ _id: PROJECT_ID });
  commentDeleteMany.mockResolvedValue({ deletedCount: 0 });
  activityLogDeleteMany.mockResolvedValue({ deletedCount: 0 });
  taskDeleteMany.mockResolvedValue({ deletedCount: 0 });
  sprintDeleteMany.mockResolvedValue({ deletedCount: 0 });
  notificationDeleteMany.mockResolvedValue({ deletedCount: 0 });
  pmMessageDeleteMany.mockResolvedValue({ deletedCount: 0 });
  projectAuditLogDeleteMany.mockResolvedValue({ deletedCount: 0 });
});

describe("DELETE /api/projects/[projectId]", () => {
  it("allows a project owner to delete", async () => {
    check.mockResolvedValue(true);

    const response = await DELETE(request(), ctx());

    expect(response.status).toBe(200);
    expect(projectFindByIdAndDelete).toHaveBeenCalledWith(PROJECT_ID);
  });

  it("denies a plain member from deleting", async () => {
    check.mockResolvedValue(false);
    getAuthUser.mockResolvedValue(MEMBER);

    const response = await DELETE(request(), ctx());

    expect(response.status).toBe(403);
    expect(projectFindByIdAndDelete).not.toHaveBeenCalled();
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
    expect(projectFindByIdAndUpdate).not.toHaveBeenCalled();
  });

  // Control: an ordinary field update must still go through, so the 403 above is about `key`
  // specifically and not the route refusing every PUT.
  it("still allows an ordinary name update", async () => {
    const res = await PUT(putRequest({ name: "Renamed" }), ctx());

    expect(res.status).toBe(200);
    expect(projectFindByIdAndUpdate).toHaveBeenCalledWith(
      PROJECT_ID,
      expect.objectContaining({ name: "Renamed" }),
      expect.anything()
    );
  });
});

describe("PUT /api/projects/[projectId] estimateFieldId", () => {
  beforeEach(() => {
    check.mockResolvedValue(true);
  });

  it("refuses a designation naming a field the project does not have", async () => {
    const res = await PUT(putRequest({ estimateFieldId: "6a70afff45d39cd9bc8bb5ff" }), ctx());

    expect(res.status).toBe(400);
    expect(projectFindByIdAndUpdate).not.toHaveBeenCalled();
  });

  it("refuses a designation naming a field that is not numeric", async () => {
    const res = await PUT(putRequest({ estimateFieldId: textFieldId }), ctx());

    expect(res.status).toBe(400);
    expect(projectFindByIdAndUpdate).not.toHaveBeenCalled();
  });

  it("refuses a designation naming an archived field", async () => {
    const res = await PUT(putRequest({ estimateFieldId: archivedNumberFieldId }), ctx());

    expect(res.status).toBe(400);
    expect(projectFindByIdAndUpdate).not.toHaveBeenCalled();
  });

  it("refuses a non-string designation instead of coercing it", async () => {
    // String([]) === "" and String([numberFieldId]) === numberFieldId — either would have
    // slipped past a bare String(...) coercion instead of being refused.
    const res = await PUT(putRequest({ estimateFieldId: [] }), ctx());

    expect(res.status).toBe(400);
    expect(projectFindByIdAndUpdate).not.toHaveBeenCalled();
  });

  it("refuses a non-string designation that would coerce to a real field id", async () => {
    const res = await PUT(putRequest({ estimateFieldId: [numberFieldId] }), ctx());

    expect(res.status).toBe(400);
    expect(projectFindByIdAndUpdate).not.toHaveBeenCalled();
  });

  it("accepts an empty designation", async () => {
    const res = await PUT(putRequest({ estimateFieldId: "" }), ctx());

    expect(res.status).toBe(200);
    expect(projectFindByIdAndUpdate).toHaveBeenCalledWith(
      PROJECT_ID,
      expect.objectContaining({ estimateFieldId: "" }),
      expect.anything()
    );
  });

  it("accepts a designation naming a numeric, non-archived field", async () => {
    const res = await PUT(putRequest({ estimateFieldId: numberFieldId }), ctx());

    expect(res.status).toBe(200);
    expect(projectFindByIdAndUpdate).toHaveBeenCalledWith(
      PROJECT_ID,
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
    projectFindById.mockReturnValue({
      lean: () => Promise.resolve(project),
      select: () => Promise.resolve({ customFields: PROJECT_CUSTOM_FIELDS }),
      toObject: () => ({ _id: PROJECT_ID, name: "Test Project" }),
      populate: saved,
    });
  }

  function updatesSentToMongo() {
    return projectFindByIdAndUpdate.mock.calls[0][1] as Record<string, unknown>;
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
      logProjectAudit.mock.calls.some(([, , , detail]) => /Coda token cleared/.test(String(detail)))
    ).toBe(true);
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
    projectFindById.mockReturnValue({
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
    expect(projectFindByIdAndUpdate).not.toHaveBeenCalled();
  });

  // Without this the refusals above would pass on a route that refuses every rename
  it("refuses a key change", async () => {
    const res = await PUT(putRequest({ key: " bp " }), ctx());

    expect(res.status).toBe(403);
    expect(projectFindByIdAndUpdate).not.toHaveBeenCalled();
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
    projectFindById.mockReturnValue({ select: () => Promise.resolve(project), populate: saved });
    projectFindByIdAndUpdate.mockReturnValue({
      lean: () => Promise.resolve({ _id: PROJECT_ID, ...project }),
    });
  }

  function lastUpdate() {
    return projectFindByIdAndUpdate.mock.calls.at(-1)?.[1] as Record<string, unknown> | undefined;
  }

  // Honours `need` and the caller, the way grants.check does: OWNER holds the owner grant, MEMBER
  // only the member one, and an instance admin passes everything
  beforeEach(() => {
    check.mockImplementation(async (user: { _id: string; role: string }, _id: string, need: string) => {
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
    expect(projectFindByIdAndUpdate).not.toHaveBeenCalled();
  });

  it("refuses the owner's machine credential", async () => {
    getAuthUser.mockResolvedValue({ ...OWNER, viaMachineCredential: true });

    const response = await PUT(putRequest({ worker: { enabled: true } }), ctx());

    expect(response.status).toBe(403);
    expect(projectFindByIdAndUpdate).not.toHaveBeenCalled();
  });

  it("refuses the owner an enable while an instance admin's lock is on", async () => {
    stored({ enabled: false, lockedByInstance: true });

    const response = await PUT(putRequest({ worker: { enabled: true } }), ctx());

    expect(response.status).toBe(403);
    expect((await response.json()).error).toMatch(/locked workers off/);
    expect(projectFindByIdAndUpdate).not.toHaveBeenCalled();
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
    expect(projectFindByIdAndUpdate).not.toHaveBeenCalled();
  });

  it("lets an instance admin lock a project, and records it for the instance", async () => {
    getAuthUser.mockResolvedValue(ADMIN);
    stored({ enabled: true });

    const response = await PUT(putRequest({ worker: { lockedByInstance: true } }), ctx());

    expect(response.status).toBe(200);
    expect(lastUpdate()).toMatchObject({ "worker.lockedByInstance": true });
    expect(logInstanceAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "project_workers_locked", target: "TP" })
    );
  });

  it("lets an instance admin switch a locked project on, since the lock is theirs", async () => {
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
      expect(projectFindByIdAndUpdate).not.toHaveBeenCalled();
    }
  );

  it("lets the owner clear one of those fields back to the default", async () => {
    stored({ enabled: true, policyOverrides: ["model"] });

    const response = await PUT(putRequest({ worker: { reset: ["model"] } }), ctx());

    expect(response.status).toBe(200);
    expect(lastUpdate()).toMatchObject({ "worker.policy.model": "opus", "worker.policyOverrides": [] });
  });

  it("still lets an instance admin set one", async () => {
    getAuthUser.mockResolvedValue(ADMIN);

    const response = await PUT(putRequest({ worker: { policy: { model: "sonnet" } } }), ctx());

    expect(response.status).toBe(200);
    expect(lastUpdate()).toMatchObject({ "worker.policy.model": "sonnet" });
  });

  it("refuses an instance admin's API token the lock", async () => {
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
    projectFindByIdAndUpdate.mockReturnValue({ lean: () => Promise.resolve(beforeImage) });
  }

  function auditDetails(): string[] {
    return logProjectAudit.mock.calls.map(([, , , detail]) =>
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
    projectFindById.mockReturnValue({
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
    expect(projectFindByIdAndUpdate.mock.calls[0][1]).toMatchObject({ githubToken: "" });
    expect(auditDetails()).toEqual(["GitHub token cleared"]);
  });

  it("refuses a null name, which cannot be cleared", async () => {
    const res = await PUT(putRequest({ name: null }), ctx());

    expect(res.status).toBe(400);
    expect(projectFindByIdAndUpdate).not.toHaveBeenCalled();
  });

  it("refuses a name left empty", async () => {
    const res = await PUT(putRequest({ name: "   " }), ctx());

    expect(res.status).toBe(400);
    expect(projectFindByIdAndUpdate).not.toHaveBeenCalled();
  });

  // Mongoose casts an object to the string it carries, and only a string is encrypted: an object
  // token was stored in the clear, and logged as anything but set
  it.each(["githubToken", "repositoryUrl", "name"])("refuses %s that is not a string", async (field) => {
    const res = await PUT(putRequest({ [field]: { _id: "ghp_not_a_string" } }), ctx());

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: `${field} must be a string` });
    expect(projectFindByIdAndUpdate).not.toHaveBeenCalled();
  });

  it("answers 404 when the project is gone by the time it is written", async () => {
    projectFindByIdAndUpdate.mockReturnValue({ lean: () => Promise.resolve(null) });

    const response = await PUT(putRequest({ name: "Orbit Two" }), ctx());

    expect(response.status).toBe(404);
    expect(logProjectAudit).not.toHaveBeenCalled();
  });
});
