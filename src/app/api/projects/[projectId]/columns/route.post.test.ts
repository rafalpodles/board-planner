import { describe, it, expect, vi, beforeEach } from "vitest";
import { DEFAULT_PROJECT_COLUMNS } from "@/types";
import { MAX_COLUMNS } from "@/lib/columns";

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
vi.mock("@/models/task", () => ({ Task: { find: vi.fn() } }));
vi.mock("@/lib/projectAudit", () => ({ logProjectAudit }));

const { POST } = await import("./route");
const { scopedToDefaultOrganisation } = await import("@/lib/db-scope");

const PROJECT_ID = "507f1f77bcf86cd799439011";
const ctx = () => ({ params: Promise.resolve({ projectId: PROJECT_ID }) });

type Column = { id: string; label: string; color: string; role: string; order: number; triggersPmReview: boolean };

const col = (id: string, label: string, order: number, role = "backlog"): Column => ({
  id,
  label,
  color: "#6b7280",
  role,
  order,
  triggersPmReview: false,
});

const reads = (columns: Column[] | undefined) =>
  projectFindOne.mockReturnValue({ select: () => ({ lean: async () => (columns === undefined ? null : { columns }) }) });

const writes = (...answers: (object | null)[]) => {
  for (const answer of answers) projectFindOneAndUpdate.mockResolvedValueOnce(answer);
};

function post(body: unknown) {
  return POST(
    new Request(`http://localhost/api/projects/${PROJECT_ID}/columns`, { method: "POST", body: JSON.stringify(body) }),
    ctx()
  );
}

const stored = [col("todo", "To Do", 0, "approved"), col("in_progress", "In Progress", 1, "active"), col("done", "Done", 2, "done")];

beforeEach(() => {
  vi.resetAllMocks();
  getAuthUser.mockResolvedValue({ _id: "u1", role: "member" });
  check.mockResolvedValue(true);
  reads(stored);
  writes({ columns: [...stored, col("qa", "QA", 3, "review")] });
});

describe("POST /api/projects/:projectId/columns", () => {
  it("appends one column with a push, and sends no list that could put back a concurrent edit", async () => {
    const res = await post({ label: " QA ", role: "review", color: "#112233" });

    expect(res.status).toBe(201);
    const [filter, update, options] = projectFindOneAndUpdate.mock.calls[0];
    expect(Object.keys(update)).toEqual(["$push"]);
    expect(update.$push.columns).toEqual({
      id: "qa",
      label: "QA",
      color: "#112233",
      role: "review",
      order: 3,
      triggersPmReview: false,
    });
    expect(options).toEqual({ returnDocument: "after" });
    expect(filter._id).toBe(PROJECT_ID);
    expect((await res.json()).map((c: Column) => c.id)).toEqual(["todo", "in_progress", "done", "qa"]);
  });

  it("puts the ceiling and the id in the write's own filter", async () => {
    await post({ label: "QA", role: "review" });

    const [filter] = projectFindOneAndUpdate.mock.calls[0];
    expect(filter[`columns.${MAX_COLUMNS - 1}`]).toEqual({ $exists: false });
    expect(filter.columns).toEqual({ $not: { $elemMatch: { id: "qa" } } });
    expect(filter["columns.0"]).toEqual({ $exists: true });
  });

  it("gives a label whose slug is taken the next free suffix", async () => {
    reads([...stored, col("qa", "QA", 3), col("qa_2", "Qa again", 4)]);

    await post({ label: "qa", role: "review" });

    expect(projectFindOneAndUpdate.mock.calls[0][1].$push.columns).toMatchObject({ id: "qa_3", order: 5 });
  });

  it("defaults the colour", async () => {
    await post({ label: "QA", role: "review" });

    expect(projectFindOneAndUpdate.mock.calls[0][1].$push.columns.color).toBe("#6b7280");
  });

  it("records the add on the project's audit trail, with the role in the words the board uses", async () => {
    await post({ label: "QA", role: "review" });

    expect(logProjectAudit).toHaveBeenCalledWith(
      scopedToDefaultOrganisation(),
      PROJECT_ID,
      "u1",
      "settings_updated",
      "Column added: QA (qa, Awaiting review)"
    );
  });

  describe("what it refuses before writing anything", () => {
    it.each([
      ["a role no automation keys on", { label: "QA", role: "testing" }, /role must be one of: backlog, approved, active, review, blocked, done/],
      ["no role", { label: "QA" }, /role must be one of/],
      ["a blank label", { label: "   ", role: "review" }, /1-40 chars/],
      ["a label of 41 characters", { label: "x".repeat(41), role: "review" }, /1-40 chars/],
      ["a label with a control character", { label: "QA\nDone", role: "review" }, /control characters/],
      ["a label with no letters in it", { label: "!!!", role: "review" }, /empty id/],
    ])("%s", async (_name, body, error) => {
      const res = await post(body);

      expect(res.status).toBe(400);
      expect((await res.json()).error).toMatch(error);
      expect(projectFindOneAndUpdate).not.toHaveBeenCalled();
    });

    it("a board that already has the most columns it may", async () => {
      reads(Array.from({ length: MAX_COLUMNS }, (_, i) => col(`c${i}`, `C${i}`, i)));

      const res = await post({ label: "QA", role: "review" });

      expect(res.status).toBe(400);
      expect((await res.json()).error).toContain(`at most ${MAX_COLUMNS} columns`);
      expect(projectFindOneAndUpdate).not.toHaveBeenCalled();
    });
  });

  it("answers 404 for a project that is gone", async () => {
    reads(undefined);

    expect((await post({ label: "QA", role: "review" })).status).toBe(404);
  });

  describe("when the board changes under it", () => {
    it("reads the board again and retries with an id that is still free", async () => {
      reads(stored);
      projectFindOneAndUpdate.mockReset();
      writes(null, { columns: [...stored, col("qa_2", "QA", 4)] });
      projectFindOne
        .mockReturnValueOnce({ select: () => ({ lean: async () => ({ columns: stored }) }) })
        .mockReturnValueOnce({ select: () => ({ lean: async () => ({ columns: [...stored, col("qa", "Taken meanwhile", 3)] }) }) });

      const res = await post({ label: "QA", role: "review" });

      expect(res.status).toBe(201);
      expect(projectFindOneAndUpdate).toHaveBeenCalledTimes(2);
      expect(projectFindOneAndUpdate.mock.calls[1][1].$push.columns.id).toBe("qa_2");
    });

    it("gives up with 409 and writes nothing when it keeps losing the race", async () => {
      projectFindOneAndUpdate.mockReset();
      projectFindOneAndUpdate.mockResolvedValue(null);

      const res = await post({ label: "QA", role: "review" });

      expect(res.status).toBe(409);
      expect(projectFindOneAndUpdate).toHaveBeenCalledTimes(3);
      expect(logProjectAudit).not.toHaveBeenCalled();
    });

    it("says it is full when the ceiling is what the write missed on", async () => {
      projectFindOneAndUpdate.mockReset();
      writes(null);
      projectFindOne
        .mockReturnValueOnce({ select: () => ({ lean: async () => ({ columns: stored }) }) })
        .mockReturnValueOnce({
          select: () => ({ lean: async () => ({ columns: Array.from({ length: MAX_COLUMNS }, (_, i) => col(`c${i}`, `C${i}`, i)) }) }),
        });

      const res = await post({ label: "QA", role: "review" });

      expect(res.status).toBe(400);
      expect(projectFindOneAndUpdate).toHaveBeenCalledTimes(1);
    });
  });

  describe("a board stored with no columns, which is shown the seven defaults", () => {
    it("keeps the defaults rather than leaving a board of one", async () => {
      reads([]);
      projectFindOneAndUpdate.mockReset();
      writes({ columns: [] });

      await post({ label: "QA", role: "review" });

      const [filter, update] = projectFindOneAndUpdate.mock.calls[0];
      expect(filter["columns.0"]).toEqual({ $exists: false });
      expect(update.$set.columns.map((c: Column) => c.id)).toEqual([...DEFAULT_PROJECT_COLUMNS.map((c) => c.id), "qa"]);
      expect(update.$set.columns.at(-1).order).toBe(7);
      expect(update.$push).toBeUndefined();
    });
  });

  describe("who may", () => {
    it("401s with no credential", async () => {
      getAuthUser.mockResolvedValue(null);

      expect((await post({ label: "QA", role: "review" })).status).toBe(401);
      expect(projectFindOneAndUpdate).not.toHaveBeenCalled();
    });

    it("refuses somebody who does not own the project, before reading it", async () => {
      check.mockResolvedValue(false);

      expect((await post({ label: "QA", role: "review" })).status).toBe(403);
      expect(check).toHaveBeenCalledWith(expect.anything(), expect.anything(), PROJECT_ID, "admin");
      expect(projectFindOne).not.toHaveBeenCalled();
      expect(projectFindOneAndUpdate).not.toHaveBeenCalled();
    });
  });
});
