import { describe, it, expect, vi, beforeEach } from "vitest";
import { Types } from "mongoose";

const { find, deleteOne, updateOne, exists, taskDeleteMany, deleteAllUploads } = vi.hoisted(() => ({
  updateOne: vi.fn(),
  exists: vi.fn(),
  find: vi.fn(),
  deleteOne: vi.fn(),
  taskDeleteMany: vi.fn(),
  deleteAllUploads: vi.fn(),
}));

vi.mock("./db", () => ({ connectDB: vi.fn() }));
vi.mock("@/models/organisation", () => ({ Organisation: { find, deleteOne, updateOne, exists } }));
vi.mock("./organisation-migration", () => ({ scopedModelNames: () => ["Task"] }));
vi.mock("./db-scope", () => ({ scoped: () => ({ Task: { deleteMany: taskDeleteMany } }), SCOPED_MODELS: {} }));
vi.mock("./upload-ownership", () => ({ UPLOAD_BUCKET: "uploads", organisationUploads: () => ({ deleteAll: deleteAllUploads }) }));

const { claimDeletion, sweepDeletedOrganisations, SUSPENSION_SETTLE_MS, TOMBSTONE_DAYS } = await import("./organisation-life-cycle");

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

describe("claimDeletion (BP-893)", () => {
  it("claims only an organisation suspended for the whole settle window, judged in the write itself", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    exists.mockResolvedValue({ _id: GONE });

    expect(await claimDeletion(GONE)).toBe(true);

    const [[filter, update]] = updateOne.mock.calls;
    expect(filter).toMatchObject({ _id: GONE, deletedAt: null, deletingAt: null });
    expect(filter.suspendedAt).toEqual({ $ne: null, $lte: new Date(NOW - SUSPENSION_SETTLE_MS) });
    expect(update).toEqual({ $set: { deletingAt: new Date(NOW) } });
    vi.useRealTimers();
  });
});
