import { describe, it, expect, afterEach } from "vitest";
import mongoose from "mongoose";
import { organisationUploads } from "./upload-ownership";

const ORGANISATION = new mongoose.Types.ObjectId("0000000000000000000000a1");
const ELSEWHERE = new mongoose.Types.ObjectId("0000000000000000000000b2");
const id = (n: number) => new mongoose.Types.ObjectId(`6a9d0f0b5d781bded2cb99${String(n).padStart(2, "0")}`);

type Row = { _id: mongoose.Types.ObjectId; length: number; filename: string; metadata: { organisation: mongoose.Types.ObjectId } };

function bucket(rows: Row[]) {
  const state = { files: [...rows], chunks: rows.map((r) => ({ files_id: r._id })) };
  const files = {
    find: (filter: Record<string, unknown>) => {
      let found = state.files.filter(
        (f) => filter["metadata.organisation"] === undefined || String(f.metadata.organisation) === String(filter["metadata.organisation"])
      );
      const cursor = {
        sort: (order: { length: number }) => {
          found = [...found].sort((a, b) => (a.length - b.length) * order.length);
          return cursor;
        },
        limit: (n: number) => {
          found = found.slice(0, n);
          return cursor;
        },
        toArray: async () => found,
      };
      return cursor;
    },
    // Only the keys the query names count, as in Mongo: a query that leaves the organisation out matches every organisation
    findOne: async (filter: { _id: mongoose.Types.ObjectId; "metadata.organisation"?: unknown }) =>
      state.files.find(
        (f) =>
          f._id.equals(filter._id) &&
          (filter["metadata.organisation"] === undefined || String(f.metadata.organisation) === String(filter["metadata.organisation"]))
      ) ?? null,
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

const db = { organisation: ORGANISATION } as never;

afterEach(() => {
  delete (mongoose.connection as unknown as Record<string, unknown>).db;
});

// BP-1025: nothing removed an uploaded file, so a full Free organisation could not make room
describe("deleting an uploaded file on an administrator's say (BP-1025)", () => {
  it("lists the organisation's files largest first, up to the limit, and none of another organisation's", async () => {
    bucket([
      { _id: id(1), length: 10, filename: "small", metadata: { organisation: ORGANISATION } },
      { _id: id(2), length: 900, filename: "huge", metadata: { organisation: ELSEWHERE } },
      { _id: id(3), length: 300, filename: "big", metadata: { organisation: ORGANISATION } },
      { _id: id(4), length: 50, filename: "middle", metadata: { organisation: ORGANISATION } },
    ]);

    const largest = await organisationUploads(db)!.largest(2);

    expect(largest.map((f) => f.filename)).toEqual(["big", "middle"]);
  });

  it("deletes the file and its chunks whoever uploaded it, and hands back the row it had", async () => {
    const state = bucket([
      { _id: id(1), length: 10, filename: "a.png", metadata: { organisation: ORGANISATION } },
      { _id: id(2), length: 20, filename: "b.png", metadata: { organisation: ORGANISATION } },
    ]);

    const gone = await organisationUploads(db)!.discard(id(1));

    expect(gone?.filename).toBe("a.png");
    expect(state.files.map((f) => String(f._id))).toEqual([String(id(2))]);
    expect(state.chunks.map((c) => String(c.files_id))).toEqual([String(id(2))]);
  });

  it("reports nothing when another delete removed the row first, so only one of two administrators is told it was theirs", async () => {
    const state = bucket([{ _id: id(1), length: 10, filename: "a.png", metadata: { organisation: ORGANISATION } }]);
    const uploads = organisationUploads(db)!;

    const [first, second] = await Promise.all([uploads.discard(id(1)), uploads.discard(id(1))]);

    expect([first, second].filter(Boolean)).toHaveLength(1);
    expect(state.files).toHaveLength(0);
  });

  it("does not touch a file of another organisation, and says there was none", async () => {
    const state = bucket([{ _id: id(1), length: 10, filename: "theirs.png", metadata: { organisation: ELSEWHERE } }]);

    expect(await organisationUploads(db)!.discard(id(1))).toBeNull();
    expect(state.files).toHaveLength(1);
    expect(state.chunks).toHaveLength(1);
  });
});
