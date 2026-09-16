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

// A snapshot taken when save() runs, not read afterwards — the mock's estimateFieldId
// reflects the final in-memory state either way, so only this tells "cleared before the
// save that persists it" apart from "cleared only after".
let savedEstimateFieldId: string | undefined;

beforeEach(() => {
  vi.clearAllMocks();
  savedEstimateFieldId = undefined;
  getAuthUser.mockResolvedValue(OWNER);
  check.mockResolvedValue(true);
  project = {
    _id: PROJECT_ID,
    estimateFieldId: numberFieldId,
    customFields: [
      { _id: { toString: () => numberFieldId }, name: "Points", fieldType: "number", archived: false },
      { _id: { toString: () => otherFieldId }, name: "Other", fieldType: "number", archived: false },
    ],
    save: vi.fn().mockImplementation(async () => {
      savedEstimateFieldId = project.estimateFieldId;
    }),
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
    expect(savedEstimateFieldId).toBe("");
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
    expect(savedEstimateFieldId).toBe("");
  });

  it("leaves the designation alone when a different field is archived", async () => {
    const res = await PATCH(patchRequest({ archived: true }), fieldCtx(otherFieldId));

    expect(res.status).toBe(200);
    expect(project.estimateFieldId).toBe(numberFieldId);
  });

  it("does not restore the designation when the field is un-archived again", async () => {
    await PATCH(patchRequest({ archived: true }), fieldCtx(numberFieldId));
    expect(project.estimateFieldId).toBe("");

    const res = await PATCH(patchRequest({ archived: false }), fieldCtx(numberFieldId));

    expect(res.status).toBe(200);
    expect(project.estimateFieldId).toBe("");
  });

  it("leaves the designation alone when the designated field is patched without archiving it", async () => {
    const res = await PATCH(patchRequest({ name: "Story Points" }), fieldCtx(numberFieldId));

    expect(res.status).toBe(200);
    expect(project.estimateFieldId).toBe(numberFieldId);
  });
});

// BP-326: removing a saved option erases it from every task, with none of the DELETE's cleanup
describe("PATCH options — who may remove one", () => {
  const dropdownId = "drop1";
  const saved = [
    { id: "opt-a", value: "Small", color: "#000000", order: 0 },
    { id: "opt-b", value: "Large", color: "#000000", order: 1 },
  ];

  beforeEach(() => {
    project.customFields.push({
      _id: { toString: () => dropdownId },
      name: "Size",
      fieldType: "dropdown",
      archived: false,
      options: saved.map((o) => ({ ...o })),
    } as (typeof project.customFields)[number]);
  });

  const asMember = () =>
    check.mockImplementation(async (_user: unknown, _project: unknown, relation: string) => relation !== "admin");

  it("refuses a member who drops a saved option", async () => {
    asMember();
    const res = await PATCH(patchRequest({ options: [saved[0]] }), fieldCtx(dropdownId));

    expect(res.status).toBe(403);
    expect(project.save).not.toHaveBeenCalled();
  });

  it("still lets a member add an option and rename one", async () => {
    asMember();
    const res = await PATCH(
      patchRequest({ options: [{ ...saved[0], value: "Tiny" }, saved[1], { value: "Huge" }] }),
      fieldCtx(dropdownId)
    );

    expect(res.status).toBe(200);
  });

  it("still lets a member archive a field, which keeps every value", async () => {
    asMember();
    const res = await PATCH(patchRequest({ archived: true }), fieldCtx(dropdownId));

    expect(res.status).toBe(200);
  });

  it("lets a project admin drop a saved option", async () => {
    const res = await PATCH(patchRequest({ options: [saved[0]] }), fieldCtx(dropdownId));

    expect(res.status).toBe(200);
    expect(check).toHaveBeenCalledWith(OWNER, PROJECT_ID, "admin");
  });
});
