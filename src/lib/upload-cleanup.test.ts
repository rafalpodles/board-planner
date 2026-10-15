import { describe, it, expect, afterEach, vi } from "vitest";
import mongoose from "mongoose";
import { releaseProjectUploads, releaseUploads, uploadIdsIn } from "./upload-cleanup";

const ORGANISATION = new mongoose.Types.ObjectId("0000000000000000000000a1");
const ELSEWHERE = new mongoose.Types.ObjectId("0000000000000000000000b2");
const BOARD = new mongoose.Types.ObjectId("0000000000000000000000c1");
const OTHER_BOARD = new mongoose.Types.ObjectId("0000000000000000000000c2");
const id = (n: number) => new mongoose.Types.ObjectId(`6a9d0f0b5d781bded2cb99${String(n).padStart(2, "0")}`);

type Row = { _id: mongoose.Types.ObjectId; metadata: { organisation: mongoose.Types.ObjectId; project: mongoose.Types.ObjectId | string } };

const sameProject = (stored: unknown, wanted: unknown[]) => wanted.some((w) => String(w) === String(stored));

function bucket(rows: Row[]) {
  const state = { files: [...rows], chunks: rows.map((r) => ({ files_id: r._id })) };
  const matches = (f: Row, filter: Record<string, unknown>) =>
    String(f.metadata.organisation) === String(filter["metadata.organisation"]) &&
    (!filter._id || (filter._id as { $in: mongoose.Types.ObjectId[] }).$in.some((x) => x.equals(f._id))) &&
    (!filter["metadata.project"] || sameProject(f.metadata.project, (filter["metadata.project"] as { $in: unknown[] }).$in));
  const files = {
    find: (filter: Record<string, unknown>) => ({ toArray: async () => state.files.filter((f) => matches(f, filter)) }),
    findOne: async (filter: { _id: mongoose.Types.ObjectId; "metadata.organisation": unknown }) =>
      state.files.find((f) => f._id.equals(filter._id) && String(f.metadata.organisation) === String(filter["metadata.organisation"])) ?? null,
    deleteOne: async ({ _id }: { _id: mongoose.Types.ObjectId }) => {
      const before = state.files.length;
      state.files = state.files.filter((f) => !f._id.equals(_id));
      return { deletedCount: before - state.files.length };
    },
  };
  const chunks = {
    deleteMany: async ({ files_id }: { files_id: mongoose.Types.ObjectId }) => {
      state.chunks = state.chunks.filter((c) => !c.files_id.equals(files_id));
    },
  };
  const fake = { collection: (name: string) => (name.endsWith(".files") ? files : chunks) };
  Object.defineProperty(mongoose.connection, "db", { get: () => fake, configurable: true });
  return state;
}

// What else in the organisation still names a file, by where it is named
function organisationWith(named: { description?: string[]; comment?: string[]; message?: string[] }) {
  const named_ = (list: string[] | undefined, filter: { $regex?: string }) => (list ?? []).some((value) => value.includes(filter.$regex ?? "\0"));
  return {
    organisation: ORGANISATION,
    Task: {
      exists: async (filter: { $or: [{ description: { $regex: string } }] }) => (named_(named.description, filter.$or[0].description) ? { _id: 1 } : null),
    },
    Comment: { exists: async (filter: { body: { $regex: string } }) => (named_(named.comment, filter.body) ? { _id: 1 } : null) },
    PmMessage: {
      exists: async (filter: { "attachments.fileId": string }) => ((named.message ?? []).includes(filter["attachments.fileId"]) ? { _id: 1 } : null),
    },
  } as never;
}

const file = (n: number, over: Partial<Row["metadata"]> = {}): Row => ({
  _id: id(n),
  metadata: { organisation: ORGANISATION, project: BOARD, ...over },
});

afterEach(() => {
  delete (mongoose.connection as unknown as Record<string, unknown>).db;
  vi.restoreAllMocks();
});

describe("which files a text names (BP-1054)", () => {
  it("finds an image and a link, once each, in any case, and ignores a near miss", () => {
    const a = String(id(1));
    const b = String(id(2));
    const text = `![x](/api/uploads/${a}) and [y](/api/uploads/${b.toUpperCase()}) and again /api/uploads/${a} but not /api/uploads/short`;

    expect(uploadIdsIn(text, null, undefined, "nothing here")).toEqual([a, b]);
  });
});

describe("releasing the files of a deleted task or comment (BP-1054)", () => {
  it("removes a file nothing else names, with its chunks", async () => {
    const state = bucket([file(1), file(2)]);

    await releaseUploads(organisationWith({}), String(BOARD), [String(id(1))]);

    expect(state.files.map((f) => String(f._id))).toEqual([String(id(2))]);
    expect(state.chunks.map((c) => String(c.files_id))).toEqual([String(id(2))]);
  });

  it("keeps a file another task, a comment or a PM message still names", async () => {
    const state = bucket([file(1), file(2), file(3)]);
    const named = organisationWith({
      description: [`/api/uploads/${id(1)}`],
      comment: [`see /api/uploads/${id(2)}`],
      message: [String(id(3))],
    });

    await releaseUploads(named, String(BOARD), [String(id(1)), String(id(2)), String(id(3))]);

    expect(state.files).toHaveLength(3);
  });

  it("does not remove a file recorded against another board, which a task may quote by id", async () => {
    const state = bucket([file(1, { project: OTHER_BOARD })]);

    await releaseUploads(organisationWith({}), String(BOARD), [String(id(1))]);

    expect(state.files).toHaveLength(1);
  });

  it("does not remove another organisation's file", async () => {
    const state = bucket([file(1, { organisation: ELSEWHERE })]);

    await releaseUploads(organisationWith({}), String(BOARD), [String(id(1))]);

    expect(state.files).toHaveLength(1);
  });

  it("finds a file whose board was recorded as the hex string", async () => {
    const state = bucket([file(1, { project: String(BOARD) })]);

    await releaseUploads(organisationWith({}), String(BOARD), [String(id(1))]);

    expect(state.files).toHaveLength(0);
  });

  it("never throws, so the delete that called it still answers", async () => {
    bucket([file(1)]);
    const reported = vi.spyOn(console, "error").mockImplementation(() => {});
    const broken = {
      organisation: ORGANISATION,
      Task: { exists: async () => { throw new Error("mongo went away"); } },
      Comment: { exists: async () => null },
      PmMessage: { exists: async () => null },
    } as never;

    await expect(releaseUploads(broken, String(BOARD), [String(id(1))])).resolves.toBeUndefined();
    expect(reported).toHaveBeenCalledWith(expect.stringContaining("mongo went away"));
  });
});

describe("releasing the files of a deleted board (BP-1054)", () => {
  it("removes every file recorded against it and none of another board's or organisation's", async () => {
    const state = bucket([file(1), file(2, { project: String(BOARD) }), file(3, { project: OTHER_BOARD }), file(4, { organisation: ELSEWHERE })]);

    await releaseProjectUploads(organisationWith({}), String(BOARD));

    expect(state.files.map((f) => String(f._id)).sort()).toEqual([String(id(3)), String(id(4))]);
    expect(state.chunks.map((c) => String(c.files_id)).sort()).toEqual([String(id(3)), String(id(4))]);
  });
});
