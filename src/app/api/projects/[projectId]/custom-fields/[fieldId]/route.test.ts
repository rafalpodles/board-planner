import { describe, it, expect, vi, beforeEach } from "vitest";

const getAuthUser = vi.fn();
const check = vi.fn();
const projectFindById = vi.fn();
const taskUpdateMany = vi.fn();

vi.mock("@/lib/db", () => ({ connectDB: vi.fn() }));
vi.mock("@/lib/auth", () => ({
  getAuthUser,
  RateLimitError: class RateLimitError extends Error {},
}));
vi.mock("@/lib/grants", () => ({ check }));
vi.mock("@/models/project", () => ({
  Project: { findById: projectFindById },
}));
vi.mock("@/models/task", () => ({
  Task: { updateMany: taskUpdateMany },
}));

const { PATCH, DELETE } = await import("./route");

const OWNER = { _id: "u1", role: "member" };
const PROJECT_ID = "507f1f77bcf86cd799439011";
const numberFieldId = "num1";
const otherFieldId = "other1";

function patchRequest(body: unknown) {
  return new Request("http://localhost/api/projects/p1/custom-fields/f1", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function deleteRequest() {
  return new Request("http://localhost/api/projects/p1/custom-fields/f1", { method: "DELETE" });
}

const fieldCtx = (fieldId: string) => ({
  params: Promise.resolve({ projectId: PROJECT_ID, fieldId }),
});

let project: {
  _id: string;
  estimateFieldId: string;
  customFields: { _id: { toString(): string }; name: string; fieldType: string; archived: boolean }[];
  save: ReturnType<typeof vi.fn>;
  markModified: ReturnType<typeof vi.fn>;
};

beforeEach(() => {
  vi.clearAllMocks();
  getAuthUser.mockResolvedValue(OWNER);
  check.mockResolvedValue(true);
  project = {
    _id: PROJECT_ID,
    estimateFieldId: numberFieldId,
    customFields: [
      { _id: { toString: () => numberFieldId }, name: "Points", fieldType: "number", archived: false },
      { _id: { toString: () => otherFieldId }, name: "Other", fieldType: "number", archived: false },
    ],
    save: vi.fn().mockResolvedValue(undefined),
    markModified: vi.fn(),
  };
  projectFindById.mockReturnValue(project);
  taskUpdateMany.mockResolvedValue({ modifiedCount: 0 });
});

describe("DELETE /api/projects/:projectId/custom-fields/:fieldId", () => {
  it("clears the designation when the field is deleted", async () => {
    const res = await DELETE(deleteRequest(), fieldCtx(numberFieldId));

    expect(res.status).toBe(200);
    expect(project.estimateFieldId).toBe("");
  });

  it("leaves the designation alone when a different field is deleted", async () => {
    const res = await DELETE(deleteRequest(), fieldCtx(otherFieldId));

    expect(res.status).toBe(200);
    expect(project.estimateFieldId).toBe(numberFieldId);
  });
});

describe("PATCH /api/projects/:projectId/custom-fields/:fieldId", () => {
  it("clears the designation when the field is archived", async () => {
    const res = await PATCH(patchRequest({ archived: true }), fieldCtx(numberFieldId));

    expect(res.status).toBe(200);
    expect(project.estimateFieldId).toBe("");
  });

  it("leaves the designation alone when a different field is archived", async () => {
    const res = await PATCH(patchRequest({ archived: true }), fieldCtx(otherFieldId));

    expect(res.status).toBe(200);
    expect(project.estimateFieldId).toBe(numberFieldId);
  });

  it("leaves the designation alone when the designated field is patched without archiving it", async () => {
    const res = await PATCH(patchRequest({ name: "Story Points" }), fieldCtx(numberFieldId));

    expect(res.status).toBe(200);
    expect(project.estimateFieldId).toBe(numberFieldId);
  });
});
