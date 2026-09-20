import { describe, it, expect, vi, beforeEach } from "vitest";
import { Types } from "mongoose";

const getAuthUser = vi.fn();
const check = vi.fn();
const taskFindOne = vi.fn();
const taskFindByIdAndUpdate = vi.fn();

vi.mock("@/lib/db", () => ({ connectDB: vi.fn() }));
vi.mock("@/lib/auth", () => ({ getAuthUser, RateLimitError: class extends Error {} }));
vi.mock("@/lib/grants", () => ({ check }));
vi.mock("@/models/task", () => ({
  Task: { findOne: taskFindOne, findByIdAndUpdate: taskFindByIdAndUpdate },
}));

const { POST } = await import("./route");

const PROJECT_ID = "507f1f77bcf86cd799439011";
const TASK_ID = "507f1f77bcf86cd799439021";
const ME = new Types.ObjectId("507f1f77bcf86cd799439031");
const SOMEBODY_ELSE = new Types.ObjectId("507f1f77bcf86cd799439032");

function post(taskId = TASK_ID) {
  return POST(
    new Request(`http://localhost/api/projects/${PROJECT_ID}/tasks/${taskId}/watch`, {
      method: "POST",
    }),
    { params: Promise.resolve({ projectId: PROJECT_ID, taskId }) }
  );
}

/** The task as stored, with whoever is already watching it. */
function watchedBy(...watchers: Types.ObjectId[]) {
  taskFindOne.mockResolvedValue({ _id: TASK_ID, project: PROJECT_ID, watchers });
}

const update = () => taskFindByIdAndUpdate.mock.calls[0]?.[1];

beforeEach(() => {
  vi.clearAllMocks();
  getAuthUser.mockResolvedValue({ _id: ME, role: "member" });
  check.mockResolvedValue(true);
  taskFindByIdAndUpdate.mockResolvedValue({});
  watchedBy();
});

describe("POST /api/projects/:projectId/tasks/:taskId/watch", () => {
  it("starts watching a task nobody is watching", async () => {
    const res = await post();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ watching: true });
    expect(update()).toEqual({ $addToSet: { watchers: ME } });
  });

  it("stops watching a task this person already watches", async () => {
    watchedBy(SOMEBODY_ELSE, ME);

    const res = await post();

    expect(await res.json()).toEqual({ watching: false });
    expect(update()).toEqual({ $pull: { watchers: ME } });
  });

  /**
   * The stored watcher is an ObjectId and the caller's id is one too, so the comparison is made
   * on both sides' string form. Comparing the values themselves would be reference equality:
   * every toggle would read as "not watching" and the row would only ever be added.
   */
  it("recognises the caller among watchers stored as ObjectIds", async () => {
    watchedBy(new Types.ObjectId(ME.toString()));

    expect(await (await post()).json()).toEqual({ watching: false });
  });

  it("leaves another person's watch alone", async () => {
    watchedBy(SOMEBODY_ELSE);

    expect(await (await post()).json()).toEqual({ watching: true });
    expect(update()).toEqual({ $addToSet: { watchers: ME } });
  });

  it("copes with a task that has no watchers array at all", async () => {
    taskFindOne.mockResolvedValue({ _id: TASK_ID, project: PROJECT_ID });

    expect(await (await post()).json()).toEqual({ watching: true });
  });

  describe("what it refuses", () => {
    it("401s with no credential", async () => {
      getAuthUser.mockResolvedValue(null);

      expect((await post()).status).toBe(401);
      expect(taskFindByIdAndUpdate).not.toHaveBeenCalled();
    });

    it("403s for somebody with no access to the project", async () => {
      check.mockResolvedValue(false);

      expect((await post()).status).toBe(403);
      expect(taskFindOne).not.toHaveBeenCalled();
    });

    /**
     * The lookup is by task AND project, so an id belonging to another board 404s here rather
     * than adding a watcher to a task the caller cannot see. Without the project in the filter
     * the access check above would have been passed for one board and spent on another.
     */
    it("404s for a task that is not this project's", async () => {
      taskFindOne.mockResolvedValue(null);

      expect((await post()).status).toBe(404);
      expect(taskFindByIdAndUpdate).not.toHaveBeenCalled();
      expect(taskFindOne).toHaveBeenCalledWith({ _id: TASK_ID, project: PROJECT_ID });
    });
  });
});
