import { describe, it, expect, vi, beforeEach } from "vitest";
import { Types } from "mongoose";

const { find, deleteOne, taskDeleteMany, deleteAllUploads } = vi.hoisted(() => ({
  find: vi.fn(),
  deleteOne: vi.fn(),
  taskDeleteMany: vi.fn(),
  deleteAllUploads: vi.fn(),
}));

vi.mock("./db", () => ({ connectDB: vi.fn() }));
vi.mock("@/models/organisation", () => ({ Organisation: { find, deleteOne } }));
vi.mock("./organisation-migration", () => ({ scopedModelNames: () => ["Task"] }));
vi.mock("./db-scope", () => ({ scoped: () => ({ Task: { deleteMany: taskDeleteMany } }), SCOPED_MODELS: {} }));
vi.mock("./upload-ownership", () => ({ UPLOAD_BUCKET: "uploads", organisationUploads: () => ({ deleteAll: deleteAllUploads }) }));

const { sweepDeletedOrganisations, TOMBSTONE_DAYS } = await import("./organisation-life-cycle");

const GONE = new Types.ObjectId();
const NOW = Date.parse("2027-03-01T00:00:00Z");

beforeEach(() => {
  vi.clearAllMocks();
  find.mockReturnValue({ select: () => ({ lean: async () => [{ _id: GONE }] }) });
  taskDeleteMany.mockResolvedValue({ deletedCount: 2 });
  deleteAllUploads.mockResolvedValue(0);
});

describe("sweepDeletedOrganisations (BP-893)", () => {
  it("frees only tombstones past the cooling-off, and purges what a straggler wrote before it does", async () => {
    expect(await sweepDeletedOrganisations(NOW)).toBe(1);

    const [[filter]] = find.mock.calls;
    expect(filter.deletedAt.$lt).toEqual(new Date(NOW - TOMBSTONE_DAYS * 24 * 60 * 60 * 1000));
    expect(taskDeleteMany).toHaveBeenCalledWith({});
    expect(deleteAllUploads).toHaveBeenCalled();
    expect(taskDeleteMany.mock.invocationCallOrder[0]).toBeLessThan(deleteOne.mock.invocationCallOrder[0]);
    expect(deleteOne).toHaveBeenCalledWith({ _id: GONE, deletedAt: { $ne: null } });
  });
});
