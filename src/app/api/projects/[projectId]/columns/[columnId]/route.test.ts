import { describe, it, expect, vi, beforeEach } from "vitest";
import { DEFAULT_PROJECT_COLUMNS } from "@/types";

const getAuthUser = vi.fn();
const check = vi.fn();
const projectFindOne = vi.fn();
const projectFindOneAndUpdate = vi.fn();
const logProjectAudit = vi.fn();

vi.mock("@/lib/db", () => ({ connectDB: vi.fn() }));
vi.mock("@/lib/auth", () => ({ getAuthUser, RateLimitError: class extends Error {} }));
vi.mock("@/lib/grants", () => ({ check }));
vi.mock("@/models/project", () => ({
  Project: { findOne: projectFindOne, findOneAndUpdate: projectFindOneAndUpdate },
}));
vi.mock("@/lib/projectAudit", () => ({ logProjectAudit }));

const { PATCH } = await import("./route");
const { scopedToDefaultOrganisation } = await import("@/lib/db-scope");

const PROJECT_ID = "507f1f77bcf86cd799439011";

type Column = { id: string; label: string; color: string; role: string; order: number; triggersPmReview: boolean };
const col = (id: string, label: string, order: number, role = "backlog"): Column => ({
  id,
  label,
  color: "#6b7280",
  role,
  order,
  triggersPmReview: false,
});
const stored = [col("todo", "To Do", 0, "approved"), col("in_progress", "In Progress", 1, "active"), col("done", "Done", 2, "done")];

const written = (answer: object | null) =>
  projectFindOneAndUpdate.mockReturnValueOnce({ lean: async () => answer });
const rereads = (project: object | null) =>
  projectFindOne.mockReturnValueOnce({ select: () => ({ lean: async () => project }) });

function patch(columnId: string, body: unknown) {
  return PATCH(
    new Request(`http://localhost/api/projects/${PROJECT_ID}/columns/${columnId}`, { method: "PATCH", body: JSON.stringify(body) }),
    { params: Promise.resolve({ projectId: PROJECT_ID, columnId }) }
  );
}

beforeEach(() => {
  vi.resetAllMocks();
  getAuthUser.mockResolvedValue({ _id: "u1", role: "member" });
  check.mockResolvedValue(true);
});

describe("PATCH /api/projects/:projectId/columns/:columnId", () => {
  it("renames one column with a positional set on its id, and sends no list", async () => {
    written({ columns: stored });

    const res = await patch("in_progress", { label: "  Doing  " });

    expect(res.status).toBe(200);
    const [filter, update, options] = projectFindOneAndUpdate.mock.calls[0];
    expect(filter).toMatchObject({ _id: PROJECT_ID, "columns.id": "in_progress" });
    expect(update).toEqual({ $set: { "columns.$[c].label": "Doing" } });
    expect(options).toEqual({ arrayFilters: [{ "c.id": "in_progress" }], returnDocument: "before" });
    expect((await res.json()).map((c: Column) => `${c.id}:${c.label}`)).toEqual(["todo:To Do", "in_progress:Doing", "done:Done"]);
  });

  it("records what the column was called, from the document the write replaced", async () => {
    written({ columns: stored });

    await patch("in_progress", { label: "Doing" });

    expect(logProjectAudit).toHaveBeenCalledWith(
      scopedToDefaultOrganisation(),
      PROJECT_ID,
      "u1",
      "settings_updated",
      "Column renamed: In Progress → Doing (in_progress)"
    );
  });

  it("writes no audit row for a rename to the name it already has", async () => {
    written({ columns: stored });

    expect((await patch("done", { label: "Done" })).status).toBe(200);
    expect(logProjectAudit).not.toHaveBeenCalled();
  });

  it.each([
    ["no label", {}],
    ["a blank label", { label: "  " }],
    ["a label over 40 characters", { label: "x".repeat(41) }],
    ["a label that is not text", { label: 5 }],
    ["a label with a control character", { label: "Done\nFast" }],
  ])("refuses %s before writing", async (_name, body) => {
    const res = await patch("done", body);

    expect(res.status).toBe(400);
    expect(projectFindOneAndUpdate).not.toHaveBeenCalled();
  });

  it("answers 404 for a column the board does not have, and for a project that is gone", async () => {
    written(null);
    rereads({ columns: stored });
    expect((await patch("nope", { label: "X" })).status).toBe(404);

    written(null);
    rereads(null);
    expect((await patch("done", { label: "X" })).status).toBe(404);
    expect(logProjectAudit).not.toHaveBeenCalled();
  });

  describe("a board stored with no columns, which is shown the seven defaults", () => {
    it("renames a default and keeps the other six", async () => {
      written(null);
      rereads({ columns: [] });
      written({ columns: [] });

      const res = await patch("todo", { label: "Next up" });

      expect(res.status).toBe(200);
      const [filter, update] = projectFindOneAndUpdate.mock.calls[1];
      expect(filter["columns.0"]).toEqual({ $exists: false });
      expect(update.$set.columns).toHaveLength(DEFAULT_PROJECT_COLUMNS.length);
      expect(update.$set.columns.find((c: Column) => c.id === "todo").label).toBe("Next up");
      expect((await res.json()).find((c: Column) => c.id === "todo").label).toBe("Next up");
    });

    it("still 404s a column that is not one of the defaults", async () => {
      written(null);
      rereads({ columns: [] });

      expect((await patch("qa", { label: "X" })).status).toBe(404);
      expect(projectFindOneAndUpdate).toHaveBeenCalledTimes(1);
    });

    it("says nothing was written when the board got its columns in between", async () => {
      written(null);
      rereads({ columns: [] });
      written(null);

      expect((await patch("todo", { label: "Next up" })).status).toBe(409);
    });
  });

  describe("who may", () => {
    it("401s with no credential", async () => {
      getAuthUser.mockResolvedValue(null);

      expect((await patch("done", { label: "X" })).status).toBe(401);
    });

    it("refuses somebody who does not own the project, before anything is read or written", async () => {
      check.mockResolvedValue(false);

      expect((await patch("done", { label: "X" })).status).toBe(403);
      expect(check).toHaveBeenCalledWith(expect.anything(), expect.anything(), PROJECT_ID, "admin");
      expect(projectFindOne).not.toHaveBeenCalled();
      expect(projectFindOneAndUpdate).not.toHaveBeenCalled();
    });
  });
});
