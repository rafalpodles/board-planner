import { describe, it, expect, vi, beforeEach } from "vitest";

const getAuthUser = vi.fn();
const check = vi.fn();
const projectFindById = vi.fn();
const taskFind = vi.fn();
const taskDeleteMany = vi.fn();
const commentDeleteMany = vi.fn();
const activityLogDeleteMany = vi.fn();
const projectFindByIdAndDelete = vi.fn();
const projectFindByIdAndUpdate = vi.fn();
const logProjectAudit = vi.fn();
const sprintDeleteMany = vi.fn();
const notificationDeleteMany = vi.fn();
const pmMessageDeleteMany = vi.fn();
const projectAuditLogDeleteMany = vi.fn();

const logInstanceAudit = vi.fn();
vi.mock("@/lib/instanceAudit", () => ({ logInstanceAudit }));
vi.mock("@/lib/db", () => ({ connectDB: vi.fn() }));
vi.mock("@/lib/auth", () => ({
  getAuthUser,
  RateLimitError: class RateLimitError extends Error {},
}));
vi.mock("@/lib/grants", () => ({ check }));
vi.mock("@/lib/projectAudit", () => ({ logProjectAudit }));
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

function request() {
  return new Request("http://localhost/api/projects/p1", { method: "DELETE" });
}

const ctx = () => ({ params: Promise.resolve({ projectId: PROJECT_ID }) });

beforeEach(() => {
  vi.clearAllMocks();
  getAuthUser.mockResolvedValue(OWNER);
  projectFindById.mockReturnValue({
    toObject: () => ({ _id: PROJECT_ID, name: "Test Project" }),
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

// The clearing rule was pinned only in the helper's own unit tests, so deleting the whole block
// from this route left the suite green — the mutation the BP-315 review ran to prove it (see also
// [[security-fix-needs-review-of-the-result]]).
describe("PUT /api/projects/[projectId] and a repointed integration host", () => {
  function putRequest(body: Record<string, unknown>) {
    return new Request("http://localhost/api/projects/p1", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  function storedProject(overrides: Record<string, unknown> = {}) {
    return {
      gitlabHost: "https://gitlab.example.com",
      gitlabToken: "enc:v2:k:stored",
      codaHost: "https://coda.io",
      codaToken: "enc:v2:k:coda",
      ...overrides,
    };
  }

  function updatesSentToMongo() {
    return projectFindByIdAndUpdate.mock.calls[0][1] as Record<string, unknown>;
  }

  beforeEach(() => {
    check.mockResolvedValue(true);
    projectFindById.mockReturnValue({ lean: () => Promise.resolve(storedProject()) });
    projectFindByIdAndUpdate.mockReturnValue({
      populate: () => Promise.resolve({ _id: PROJECT_ID, toObject: () => ({ _id: PROJECT_ID }) }),
    });
  });

  it("clears the stored token when the host is repointed", async () => {
    const response = await PUT(putRequest({ gitlabHost: "https://collector.attacker.example" }), ctx());

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
    projectFindById.mockReturnValue({
      lean: () => Promise.resolve(storedProject({ gitlabHost: undefined })),
    });

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
