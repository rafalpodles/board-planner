import { describe, it, expect, afterEach, vi } from "vitest";
import mongoose from "mongoose";
import { organisationUploads } from "./upload-ownership";
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

// What else in the organisation still names a file, by where it is named. The fakes honour the
// regex and the id list the query sends, so a query that forgets a place finds nothing there.
function organisationWith(named: { description?: string[]; checklist?: string[]; comment?: string[]; content?: string[]; attachments?: string[] }) {
  const hits = (list: string[] | undefined, filter: { $regex: string; $options?: string }) =>
    (list ?? []).filter((value) => new RegExp(filter.$regex, filter.$options).test(value));
  const rows = <T,>(found: T[]) => ({ select: () => ({ lean: async () => found }) });
  return {
    organisation: ORGANISATION,
    Task: {
      find: (filter: { $or: [{ description: { $regex: string; $options?: string } }, { "checklist.text": { $regex: string; $options?: string } }] }) =>
        rows([
          ...hits(named.description, filter.$or[0].description).map((description) => ({ description, checklist: [] })),
          ...hits(named.checklist, filter.$or[1]["checklist.text"]).map((text) => ({ description: "", checklist: [{ text }] })),
        ]),
    },
    Comment: { find: (filter: { body: { $regex: string; $options?: string } }) => rows(hits(named.comment, filter.body).map((body) => ({ body }))) },
    PmMessage: {
      find: (filter: { $or: [{ "attachments.fileId": { $in: string[] } }, { content: { $regex: string; $options?: string } }] }) =>
        rows([
          ...(named.attachments ?? [])
            .filter((fileId) => filter.$or[0]["attachments.fileId"].$in.includes(fileId))
            .map((fileId) => ({ content: "", attachments: [{ fileId }] })),
          ...hits(named.content, filter.$or[1].content).map((content) => ({ content, attachments: [] })),
        ]),
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

  it("keeps a file another task's description, a checklist item, a comment or a PM message still names", async () => {
    const state = bucket([file(1), file(2), file(3), file(4), file(5)]);
    const named = organisationWith({
      description: [`/api/uploads/${id(1)}`],
      checklist: [`Looks like /api/uploads/${id(2)}`],
      comment: [`see /api/uploads/${id(3)}`],
      content: [`![shot](/api/uploads/${id(4)})`],
      attachments: [String(id(5))],
    });

    await releaseUploads(named, String(BOARD), [1, 2, 3, 4, 5].map((n) => String(id(n))));

    expect(state.files).toHaveLength(5);
  });

  it("keeps a file that another row names with capital letters", async () => {
    const state = bucket([file(1)]);

    await releaseUploads(organisationWith({ description: [`/api/uploads/${String(id(1)).toUpperCase()}`] }), String(BOARD), [String(id(1))]);

    expect(state.files).toHaveLength(1);
  });

  it("goes on to the next file when one cannot be removed", async () => {
    const state = bucket([file(1), file(2)]);
    const reported = vi.spyOn(console, "error").mockImplementation(() => {});
    const original = mongoose.connection.db!.collection;
    let failed = false;
    const patched = {
      collection: (name: string) => {
        const real = original.call(mongoose.connection.db!, name) as unknown as { deleteOne?: (...a: unknown[]) => Promise<unknown> };
        if (!name.endsWith(".files") || failed) return real;
        return { ...real, deleteOne: async () => { failed = true; throw new Error("disk full"); } };
      },
    };
    Object.defineProperty(mongoose.connection, "db", { get: () => ({ collection: patched.collection }), configurable: true });

    await releaseUploads(organisationWith({}), String(BOARD), [String(id(1)), String(id(2))]);

    expect(reported).toHaveBeenCalledWith(expect.stringContaining("disk full"));
    expect(state.files.length).toBeLessThan(2);
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
      Task: { find: () => { throw new Error("mongo went away"); } },
      Comment: { find: () => ({ select: () => ({ lean: async () => [] }) }) },
      PmMessage: { find: () => ({ select: () => ({ lean: async () => [] }) }) },
    } as never;

    await expect(releaseUploads(broken, String(BOARD), [String(id(1))])).resolves.toBeUndefined();
    expect(reported).toHaveBeenCalledWith(expect.stringContaining("mongo went away"));
  });

  it("looks in each collection once for the whole set, not once per file", async () => {
    bucket([file(1), file(2), file(3)]);
    const calls = { task: 0, comment: 0, message: 0 };
    const empty = { select: () => ({ lean: async () => [] }) };
    const counted = {
      organisation: ORGANISATION,
      Task: { find: () => (calls.task++, empty) },
      Comment: { find: () => (calls.comment++, empty) },
      PmMessage: { find: () => (calls.message++, empty) },
    } as never;

    await releaseUploads(counted, String(BOARD), [1, 2, 3].map((n) => String(id(n))));

    expect(calls).toEqual({ task: 1, comment: 1, message: 1 });
  });
});

describe("which files a board holds (BP-1054)", () => {
  it("names only this organisation's, recorded against this board, whatever way the board was recorded", async () => {
    bucket([file(1), file(2, { project: String(BOARD) }), file(3, { project: OTHER_BOARD }), file(4, { organisation: ELSEWHERE })]);

    const found = await organisationUploads({ organisation: ORGANISATION } as never)!.ofProject([1, 2, 3, 4].map((n) => id(n)), String(BOARD));

    expect(found.map((f) => String(f._id)).sort()).toEqual([String(id(1)), String(id(2))]);
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
