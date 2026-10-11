import { describe, it, expect, afterEach } from "vitest";
import mongoose from "mongoose";
import { organisationUploads } from "./upload-ownership";

const ORGANISATION = new mongoose.Types.ObjectId("0000000000000000000000a1");
const MINE = new mongoose.Types.ObjectId("6a9d0f0b5d781bded2cb9901");
const THEIRS = new mongoose.Types.ObjectId("6a9d0f0b5d781bded2cb9902");

type Row = { _id: mongoose.Types.ObjectId; metadata: { organisation: mongoose.Types.ObjectId; uploadedBy: string } };

function bucket(rows: Row[]) {
  const chunks: { files_id: mongoose.Types.ObjectId }[] = rows.map((r) => ({ files_id: r._id }));
  const state = { files: [...rows], chunks };
  const files = {
    find: (filter: { _id: { $in: mongoose.Types.ObjectId[] }; "metadata.organisation": unknown; "metadata.uploadedBy": string }) => ({
      toArray: async () =>
        state.files.filter(
          (f) =>
            filter._id.$in.some((id) => id.equals(f._id)) &&
            String(f.metadata.organisation) === String(filter["metadata.organisation"]) &&
            f.metadata.uploadedBy === filter["metadata.uploadedBy"]
        ),
    }),
    deleteOne: async ({ _id }: { _id: mongoose.Types.ObjectId }) => {
      state.files = state.files.filter((f) => !f._id.equals(_id));
    },
  };
  const chunkCollection = {
    deleteMany: async ({ files_id }: { files_id: mongoose.Types.ObjectId }) => {
      state.chunks = state.chunks.filter((c) => !c.files_id.equals(files_id));
    },
  };
  const fake = { collection: (name: string) => (name.endsWith(".files") ? files : chunkCollection) };
  Object.defineProperty(mongoose.connection, "db", { get: () => fake, configurable: true });
  return state;
}

const db = { organisation: ORGANISATION } as never;

afterEach(() => {
  delete (mongoose.connection as unknown as Record<string, unknown>).db;
});

describe("removing uploaded files", () => {
  it("removes the person's own files with their chunks, and not another person's, even when named", async () => {
    const state = bucket([
      { _id: MINE, metadata: { organisation: ORGANISATION, uploadedBy: "jan" } },
      { _id: THEIRS, metadata: { organisation: ORGANISATION, uploadedBy: "ola" } },
    ]);

    await organisationUploads(db)!.remove([String(MINE), String(THEIRS)], "jan");

    expect(state.files.map((f) => String(f._id))).toEqual([String(THEIRS)]);
    expect(state.chunks.map((c) => String(c.files_id))).toEqual([String(THEIRS)]);
  });

  it("does nothing for ids that are not ids", async () => {
    const state = bucket([{ _id: MINE, metadata: { organisation: ORGANISATION, uploadedBy: "jan" } }]);
    await organisationUploads(db)!.remove(["not-an-id", ""], "jan");
    expect(state.files).toHaveLength(1);
  });
});
