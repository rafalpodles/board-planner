import { describe, it, expect, vi, beforeEach } from "vitest";

const getAuthUser = vi.fn();
const check = vi.fn();
const projectFindById = vi.fn();
const projectFindOneAndUpdate = vi.fn();
const projectUpdateOne = vi.fn();
const taskUpdateMany = vi.fn();
const logProjectAudit = vi.fn();

vi.mock("@/lib/db", () => ({ connectDB: vi.fn() }));
vi.mock("@/lib/auth", () => ({
  getAuthUser,
  RateLimitError: class RateLimitError extends Error {},
}));
vi.mock("@/lib/grants", () => ({ check }));
vi.mock("@/lib/projectAudit", () => ({ logProjectAudit }));
vi.mock("@/models/project", () => ({
  Project: {
    findById: projectFindById,
    findOneAndUpdate: projectFindOneAndUpdate,
    updateOne: projectUpdateOne,
  },
}));
vi.mock("@/models/task", () => ({
  Task: { updateMany: taskUpdateMany },
}));
// The schema's own casting is exercised where project-write-images is tested; here the update is
// laid over the before-image as written
vi.mock("@/lib/project-write-images", () => ({
  projectWriteImages: (before: Record<string, unknown>, updates: Record<string, unknown>) => {
    const after = JSON.parse(JSON.stringify(before));
    for (const [path, value] of Object.entries(updates)) {
      const keys = path.split(".");
      let node = after;
      for (const key of keys.slice(0, -1)) node = node[key];
      node[keys[keys.length - 1]] = value;
    }
    return { before, after: { toObject: () => after } };
  },
}));

const { PATCH, DELETE } = await import("./route");

const OWNER = { _id: "u1", role: "member" };
const PROJECT_ID = "507f1f77bcf86cd799439011";
const numberFieldId = "6a70afff45d39cd9bc8bb5d1";
const otherFieldId = "6a70afff45d39cd9bc8bb5d2";
const dropdownId = "6a70afff45d39cd9bc8bb5d3";

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

type Field = {
  _id: string;
  name: string;
  fieldType: string;
  archived: boolean;
  required?: boolean;
  options?: { id: string; value: string; color: string; order: number }[];
};

let project: { _id: string; estimateFieldId: string; customFields: Field[] };

const image = () => JSON.parse(JSON.stringify(project));
const query = (result: unknown) => ({ lean: () => Promise.resolve(result) });

beforeEach(() => {
  vi.clearAllMocks();
  getAuthUser.mockResolvedValue(OWNER);
  check.mockResolvedValue(true);
  project = {
    _id: PROJECT_ID,
    estimateFieldId: numberFieldId,
    customFields: [
      { _id: numberFieldId, name: "Points", fieldType: "number", archived: false },
      { _id: otherFieldId, name: "Other", fieldType: "number", archived: false },
    ],
  };
  projectFindById.mockImplementation(() => ({ select: () => query(image()) }));
  // Each writer is one atomic operation, so the stub applies it the way the database would and
  // answers the document as it stood before
  projectFindOneAndUpdate.mockImplementation(
    (
      filter: Record<string, unknown>,
      update: { $set?: Record<string, unknown>; $pull?: { customFields: { _id: string } } }
    ) => {
      const before = image();
      if (update.$pull) {
        project.customFields = project.customFields.filter((f) => f._id !== update.$pull!.customFields._id);
        return query(before);
      }
      const field = project.customFields.find((f) => f._id === filter["customFields._id"]);
      if (!field) return query(null);
      for (const [path, value] of Object.entries(update.$set ?? {})) {
        (field as Record<string, unknown>)[path.split(".$.")[1]] = value;
      }
      return query(before);
    }
  );
  projectUpdateOne.mockImplementation(async (filter: { estimateFieldId: string }) => {
    if (project.estimateFieldId !== filter.estimateFieldId) return { modifiedCount: 0 };
    project.estimateFieldId = "";
    return { modifiedCount: 1 };
  });
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

  // BP-782: the whole list was saved back, so a field added meanwhile vanished with the deleted one
  it("pulls the one field instead of saving the list back", async () => {
    const res = await DELETE(deleteRequest(), fieldCtx(otherFieldId));

    expect(projectFindOneAndUpdate).toHaveBeenCalledWith(
      { _id: PROJECT_ID },
      { $pull: { customFields: { _id: otherFieldId } } },
      { returnDocument: "before" }
    );
    expect(projectFindById).not.toHaveBeenCalled();
    expect((await res.json()).map((f: Field) => f._id)).toEqual([numberFieldId]);
  });

  it("records the removal, and the designation that went with it", async () => {
    await DELETE(deleteRequest(), fieldCtx(numberFieldId));

    expect(logProjectAudit).toHaveBeenCalledWith(PROJECT_ID, "u1", "settings_updated", [
      "Custom field removed: Points",
      "Estimate field: Points → none",
    ]);
  });

  it("records no removal of a field that was already gone", async () => {
    project.customFields = project.customFields.filter((f) => f._id !== otherFieldId);

    const res = await DELETE(deleteRequest(), fieldCtx(otherFieldId));

    expect(res.status).toBe(200);
    expect(logProjectAudit).not.toHaveBeenCalled();
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

  it("clears a designation still pointing at a field archived before the rule existed", async () => {
    project.customFields[0].archived = true;

    await PATCH(patchRequest({ name: "Old points" }), fieldCtx(numberFieldId));

    expect(project.estimateFieldId).toBe("");
  });

  // BP-782: the whole list was saved back, so a field added or edited meanwhile was put back
  it("writes this field's own paths, nothing else", async () => {
    await PATCH(patchRequest({ name: "Story Points", required: true }), fieldCtx(numberFieldId));

    expect(projectFindOneAndUpdate).toHaveBeenCalledWith(
      { _id: PROJECT_ID, "customFields._id": numberFieldId },
      { $set: { "customFields.$.name": "Story Points", "customFields.$.required": true } },
      { returnDocument: "before" }
    );
  });

  it("records each change from the write's own before-image", async () => {
    await PATCH(
      patchRequest({ name: "Story Points", required: true, archived: true }),
      fieldCtx(numberFieldId)
    );

    expect(logProjectAudit).toHaveBeenCalledWith(PROJECT_ID, "u1", "settings_updated", [
      "Custom field Points · Name: Points → Story Points",
      "Custom field Points · Required: off → on",
      "Custom field Points · Archived: off → on",
      "Estimate field: Points → none",
    ]);
  });

  it("records nothing when what was sent is what was stored", async () => {
    await PATCH(patchRequest({ name: "Points", archived: false }), fieldCtx(numberFieldId));

    expect(logProjectAudit).not.toHaveBeenCalled();
  });

  it("answers with the list as the write left it", async () => {
    const res = await PATCH(patchRequest({ name: "Story Points" }), fieldCtx(numberFieldId));

    expect((await res.json())[0]).toMatchObject({ _id: numberFieldId, name: "Story Points" });
  });

  it("404s a field deleted between its read and its write", async () => {
    projectFindOneAndUpdate.mockImplementation(() => query(null));

    const res = await PATCH(patchRequest({ name: "Story Points" }), fieldCtx(numberFieldId));

    expect(res.status).toBe(404);
    expect(logProjectAudit).not.toHaveBeenCalled();
  });

  it("404s an id that is not one, without reading or writing", async () => {
    const res = await PATCH(patchRequest({ name: "x" }), fieldCtx("not-an-id"));

    expect(res.status).toBe(404);
    expect(projectFindById).not.toHaveBeenCalled();
    expect(projectFindOneAndUpdate).not.toHaveBeenCalled();
  });
});

// BP-326: removing a saved option erases it from every task, with none of the DELETE's cleanup
describe("PATCH options — who may remove one", () => {
  const saved = [
    { id: "opt-a", value: "Small", color: "#000000", order: 0 },
    { id: "opt-b", value: "Large", color: "#000000", order: 1 },
  ];

  beforeEach(() => {
    project.customFields.push({
      _id: dropdownId,
      name: "Size",
      fieldType: "dropdown",
      archived: false,
      options: saved.map((o) => ({ ...o })),
    });
  });

  const asMember = () =>
    check.mockImplementation(async (_user: unknown, _project: unknown, relation: string) => relation !== "admin");

  it("refuses a member who drops a saved option", async () => {
    asMember();
    const res = await PATCH(patchRequest({ options: [saved[0]] }), fieldCtx(dropdownId));

    expect(res.status).toBe(403);
    expect(projectFindOneAndUpdate).not.toHaveBeenCalled();
  });

  it("still lets a member add an option and rename one", async () => {
    asMember();
    const res = await PATCH(
      patchRequest({ options: [{ ...saved[0], value: "Tiny" }, saved[1], { value: "Huge" }] }),
      fieldCtx(dropdownId)
    );

    expect(res.status).toBe(200);
    expect(logProjectAudit).toHaveBeenCalledWith(PROJECT_ID, "u1", "settings_updated", [
      "Custom field Size · Options: Small, Large → Tiny, Large, Huge",
    ]);
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
