import { describe, it, expect, vi } from "vitest";
import { Types } from "mongoose";
import { migrateRepositories } from "./repositories-migration";

function fakeDb(projects: Record<string, unknown>[]) {
  const updateOne = vi.fn(async () => ({}));
  const db = { collection: () => ({ find: () => ({ toArray: async () => projects }), updateOne }) };
  return { db: db as never, updateOne };
}

const listed = { _id: new Types.ObjectId(), key: "OK", repositoryUrl: "https://github.com/a/b", repositories: [{ url: "https://github.com/a/b" }] };
const bare = { _id: new Types.ObjectId(), key: "NEW", repositoryUrl: "https://github.com/a/c" };
const legacy = { _id: new Types.ObjectId(), key: "OLD", githubRepo: "a/d" };
const none = { _id: new Types.ObjectId(), key: "NONE" };
const huge = { _id: new Types.ObjectId(), key: "HUGE", repositoryUrl: `https://github.com/${"x".repeat(2048)}` };

describe("migrateRepositories", () => {
  it("lists what it would fill and writes nothing on a dry run", async () => {
    const { db, updateOne } = fakeDb([listed, bare, legacy, none, huge]);
    expect(await migrateRepositories(db, { apply: false })).toEqual({
      filled: ["NEW: https://github.com/a/c", "OLD: https://github.com/a/d"],
      alreadyListed: 1,
      noRepository: 1,
      tooLong: ["HUGE"],
    });
    expect(updateOne).not.toHaveBeenCalled();
  });

  it("fills only a project with no list yet, guarded so a concurrent write is not overwritten", async () => {
    const { db, updateOne } = fakeDb([listed, bare, huge]);
    await migrateRepositories(db, { apply: true });
    expect(updateOne).toHaveBeenCalledTimes(1);
    const [filter, update] = updateOne.mock.calls[0] as unknown as [Record<string, unknown>, { $set: { repositories: { url: string }[] } }];
    expect(filter).toEqual({ _id: bare._id, $or: [{ repositories: null }, { repositories: { $size: 0 } }] });
    expect(update.$set.repositories).toEqual([expect.objectContaining({ url: "https://github.com/a/c", name: "" })]);
  });
});
