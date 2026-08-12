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
vi.mock("@/lib/instanceAudit", () => ({ logInstanceAudit }));
vi.mock("@/lib/db", () => ({ connectDB: vi.fn() }));
vi.mock("@/lib/auth", () => ({
  getAuthUser,
  RateLimitError: class RateLimitError extends Error {},
}));
vi.mock("@/lib/grants", () => ({ check }));
vi.mock("@/lib/projectAudit", () => ({ logProjectAudit: vi.fn() }));
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
