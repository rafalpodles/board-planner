import { describe, it, expect, vi, beforeEach } from "vitest";

const pmFindOne = vi.fn();
const commentFindOne = vi.fn();
const taskFindOne = vi.fn();
const taskFindById = vi.fn();
const updateOne = vi.fn();

vi.mock("@/models/pmMessage", () => ({ PmMessage: { findOne: pmFindOne } }));
vi.mock("@/models/comment", () => ({ Comment: { findOne: commentFindOne } }));
vi.mock("@/models/task", () => ({ Task: { findOne: taskFindOne, findById: taskFindById } }));
vi.mock("mongoose", () => ({
  default: {
    connection: { db: { collection: () => ({ updateOne }) } },
    mongo: { GridFSBucket: class {} },
    Types: { ObjectId: class {} },
  },
}));

const { projectForUpload } = await import("./upload-ownership");

const FILE = { _id: "f1" as unknown as never };
const lean = (value: unknown) => ({ select: () => ({ lean: () => Promise.resolve(value) }) });

beforeEach(() => {
  vi.clearAllMocks();
  pmFindOne.mockReturnValue(lean(null));
  commentFindOne.mockReturnValue(lean(null));
  taskFindOne.mockReturnValue(lean(null));
  taskFindById.mockReturnValue(lean(null));
  updateOne.mockResolvedValue({});
});

describe("projectForUpload", () => {
  it("uses the project recorded at upload time without searching", async () => {
    const project = await projectForUpload({ ...FILE, metadata: { project: "p1" } }, "abc");

    expect(project).toBe("p1");
    expect(pmFindOne).not.toHaveBeenCalled();
    expect(commentFindOne).not.toHaveBeenCalled();
  });

  it("recovers a legacy file's project from a PM attachment", async () => {
    pmFindOne.mockReturnValue(lean({ project: "p2" }));

    expect(await projectForUpload({ ...FILE, metadata: {} }, "abc")).toBe("p2");
  });

  it("recovers it from a comment that embeds the reference", async () => {
    commentFindOne.mockReturnValue(lean({ task: "t1" }));
    taskFindById.mockReturnValue(lean({ project: "p3" }));

    expect(await projectForUpload({ ...FILE, metadata: {} }, "abc")).toBe("p3");
  });

  it("writes the recovered project back so the search happens once", async () => {
    pmFindOne.mockReturnValue(lean({ project: "p2" }));

    await projectForUpload({ ...FILE, metadata: {} }, "abc");

    expect(updateOne).toHaveBeenCalledWith(
      { _id: "f1" },
      { $set: { "metadata.project": "p2" } }
    );
  });

  it("is null when nothing references the file, so it cannot be read", async () => {
    expect(await projectForUpload({ ...FILE, metadata: {} }, "orphan")).toBeNull();
    expect(updateOne).not.toHaveBeenCalled();
  });
});
