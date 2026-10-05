import { describe, it, expect, vi } from "vitest";
import type { ScopedDb } from "@/lib/db-scope";

vi.mock("@/lib/db", () => ({ connectDB: vi.fn() }));

const { PM_TOOLS } = await import("./tools");
const { buildBoardDigest } = await import("./board-review");

const ctx = { projectId: "507f1f77bcf86cd799439011", projectKey: "BP", pmUserId: "pm", triggeredByUserId: "pm" };

function fakeDb() {
  const find = vi.fn((..._args: unknown[]) => undefined as unknown);
  const countDocuments = vi.fn(async (..._args: unknown[]) => 0);
  const aggregate = vi.fn(async (..._args: unknown[]) => [] as unknown[]);
  const chain = (rows: unknown[]) => {
    const self: Record<string, unknown> = {};
    for (const step of ["sort", "skip", "limit", "populate"]) self[step] = () => self;
    self.lean = async () => rows;
    self.then = (resolve: (rows: unknown[]) => unknown) => resolve(rows);
    return self;
  };
  find.mockImplementation(() => chain([]));
  const db = {
    Task: { find, countDocuments, aggregate },
    Project: { findById: () => ({ lean: async () => ({ key: "BP", columns: [] }) }) },
    ActivityLog: { find: () => chain([]) },
  };
  return { db: db as unknown as ScopedDb, find, countDocuments, aggregate };
}

describe("what the PM agent sees of an archived task", () => {
  it("lists neither it nor counts it", async () => {
    const { db, find, countDocuments } = fakeDb();

    await PM_TOOLS.list_tasks.execute(db, {}, ctx);

    expect(countDocuments.mock.calls[0][0]).toMatchObject({ archivedAt: null });
    expect(find.mock.calls[0][0]).toMatchObject({ archivedAt: null });
  });

  it("leaves it out of the counts by status", async () => {
    const { db, aggregate } = fakeDb();

    await PM_TOOLS.get_project_stats.execute(db, {}, ctx);

    const [pipeline] = aggregate.mock.calls[0] as [{ $match?: Record<string, unknown> }[]];
    expect(pipeline[0].$match).toMatchObject({ archivedAt: null });
  });

  it("leaves it out of the board review", async () => {
    const { db, find, countDocuments } = fakeDb();

    await buildBoardDigest(db, ctx.projectId);

    expect(countDocuments.mock.calls[0][0]).toMatchObject({ archivedAt: null });
    expect(find.mock.calls[0][0]).toMatchObject({ archivedAt: null });
  });
});
