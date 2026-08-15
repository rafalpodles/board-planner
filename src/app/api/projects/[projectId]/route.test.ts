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

beforeEach(() => {
  vi.clearAllMocks();
  getAuthUser.mockResolvedValue(OWNER);
  projectFindById.mockReturnValue({
    toObject: () => ({ _id: PROJECT_ID, name: "Test Project" }),
    select: () => Promise.resolve({ customFields: PROJECT_CUSTOM_FIELDS }),
  });
  projectFindByIdAndUpdate.mockReturnValue({
    populate: () =>
      Promise.resolve({
        _id: PROJECT_ID,
        toObject: () => ({ _id: PROJECT_ID, name: "Test Project" }),
      }),
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
