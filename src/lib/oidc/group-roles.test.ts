import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Types } from "mongoose";

const ownerCount = vi.fn();
const logProjectAudit = vi.fn();
const logInstanceAudit = vi.fn();
const providerFor = vi.fn();
vi.mock("@/lib/grants", () => ({ ownerCount }));
vi.mock("@/lib/projectAudit", () => ({ logProjectAudit }));
vi.mock("@/lib/instanceAudit", () => ({ logInstanceAudit }));
vi.mock("@/lib/oidc/providers", () => ({ providerFor }));

const { applyGroupRoles } = await import("./group-roles");

const BOARD = new Types.ObjectId();
const OTHER_BOARD = new Types.ObjectId();
const USER = { _id: new Types.ObjectId(), username: "ada", kind: "human", deactivatedAt: null } as never as Parameters<typeof applyGroupRoles>[1];

let boards: Record<string, unknown>[];
let grants: Map<string, Record<string, unknown> | null>;
const find = vi.fn();
const updateOne = vi.fn();
const deleteOne = vi.fn();
const findOne = vi.fn();
const db = {
  organisation: new Types.ObjectId(),
  Project: { find: (filter: unknown) => (find(filter), { select: () => ({ lean: async () => boards }) }) },
  Grant: {
    findOne: (where: { object: Types.ObjectId }) => (findOne(where), { select: () => ({ lean: async () => {
      const row = grants.get(String(where.object));
      if (row === undefined) throw new Error("boom");
      return row;
    } }) }),
    updateOne,
    deleteOne,
  },
} as never as Parameters<typeof applyGroupRoles>[0];

const mapped = (...rows: [string, "owner" | "member"][]) => ({ _id: BOARD, key: "TP", groupRoleMap: rows.map(([group, role]) => ({ group, role })) });

beforeEach(() => {
  vi.clearAllMocks();
  boards = [mapped(["staff", "member"], ["leads", "owner"])];
  grants = new Map([[String(BOARD), null]]);
  updateOne.mockResolvedValue({ upsertedCount: 1, modifiedCount: 1 });
  deleteOne.mockResolvedValue({ deletedCount: 1 });
  ownerCount.mockResolvedValue(2);
});
afterEach(() => {
  delete process.env.ORGANISATION_DOMAIN;
  vi.restoreAllMocks();
});

const run = (groups: string[], known = true, providerId = "oidc", user = USER) => applyGroupRoles(db, user, providerId, groups, known);

describe("the group mapping of a board, applied at sign-in (BP-862)", () => {
  it("only looks at boards that map something", async () => {
    await run(["staff"]);

    expect(find).toHaveBeenCalledWith({ "groupRoleMap.0": { $exists: true } });
  });

  it("gives a person in a mapped group the role, as a grant the mapping made, and records it", async () => {
    await run(["staff"]);

    expect(updateOne).toHaveBeenCalledWith(
      { subject: USER._id, objectType: "project", object: BOARD },
      { $setOnInsert: { relation: "member", source: "idp", createdBy: null } },
      { upsert: true }
    );
    expect(logProjectAudit).toHaveBeenCalledWith(db, String(BOARD), USER._id, "member_added", expect.stringContaining("no access → member"));
    expect(logInstanceAudit).toHaveBeenCalledWith(db, expect.objectContaining({ action: "user_role_changed", target: "ada", detail: expect.stringContaining("TP: no access → member") }));
  });

  it("gives the highest role among the groups a person is in", async () => {
    await run(["staff", "leads"]);

    expect(updateOne.mock.calls[0][1].$setOnInsert.relation).toBe("owner");
  });

  it("records nothing when the grant was made meanwhile by somebody else", async () => {
    updateOne.mockResolvedValue({ upsertedCount: 0, modifiedCount: 0 });

    await run(["staff"]);

    expect(logProjectAudit).not.toHaveBeenCalled();
  });

  it("changes the role of a grant the mapping made when the groups now give another", async () => {
    grants.set(String(BOARD), { relation: "member", source: "idp" });

    await run(["leads"]);

    expect(updateOne).toHaveBeenCalledWith({ subject: USER._id, objectType: "project", object: BOARD, source: "idp" }, { $set: { relation: "owner" } });
    expect(logProjectAudit).toHaveBeenCalledWith(db, String(BOARD), USER._id, "member_role_changed", expect.stringContaining("member → owner"));
  });

  it("removes a grant the mapping made when the person left every mapped group, and only such a grant", async () => {
    grants.set(String(BOARD), { relation: "member", source: "idp" });

    await run(["other"]);

    expect(deleteOne).toHaveBeenCalledWith({ subject: USER._id, objectType: "project", object: BOARD, source: "idp" });
    expect(logProjectAudit).toHaveBeenCalledWith(db, String(BOARD), USER._id, "member_removed", expect.stringContaining("member → no access"));
  });

  it("leaves a grant somebody made by hand alone, whatever the groups say", async () => {
    grants.set(String(BOARD), { relation: "member", source: "manual" });
    await run([]);
    await run(["leads"]);

    expect(updateOne).not.toHaveBeenCalled();
    expect(deleteOne).not.toHaveBeenCalled();
  });

  it("reads a grant older than the field as made by hand", async () => {
    grants.set(String(BOARD), { relation: "owner" });

    await run([]);

    expect(deleteOne).not.toHaveBeenCalled();
  });

  it("changes nothing when the token had no groups claim at all", async () => {
    grants.set(String(BOARD), { relation: "member", source: "idp" });

    await run([], false);

    expect(find).not.toHaveBeenCalled();
    expect(deleteOne).not.toHaveBeenCalled();
    expect(updateOne).not.toHaveBeenCalled();
  });

  it("does nothing for another provider, a machine or a deactivated account", async () => {
    await run(["staff"], true, "google");
    await run(["staff"], true, "oidc", { ...USER, kind: "machine" } as never);
    await run(["staff"], true, "oidc", { ...USER, deactivatedAt: new Date() } as never);

    expect(find).not.toHaveBeenCalled();
  });

  it("never removes or demotes the last owner", async () => {
    grants.set(String(BOARD), { relation: "owner", source: "idp" });
    ownerCount.mockResolvedValue(1);
    await run(["other"]);
    await run(["staff"]);

    expect(deleteOne).not.toHaveBeenCalled();
    expect(updateOne).not.toHaveBeenCalled();
  });

  it("removes an owner the mapping made while another owner remains", async () => {
    grants.set(String(BOARD), { relation: "owner", source: "idp" });

    await run(["other"]);

    expect(deleteOne).toHaveBeenCalled();
  });

  it("puts an owner back when a racing sign-in left the board with none, and records no change", async () => {
    grants.set(String(BOARD), { relation: "owner", source: "idp" });
    ownerCount.mockResolvedValueOnce(2).mockResolvedValueOnce(0);

    await run(["other"]);

    expect(updateOne).toHaveBeenCalledWith(
      { subject: USER._id, objectType: "project", object: BOARD },
      { $setOnInsert: { relation: "owner", source: "idp", createdBy: null } },
      { upsert: true }
    );
    expect(logProjectAudit).not.toHaveBeenCalled();
  });

  it("puts a demoted owner back only where the row is still the mapping's, never over a grant made by hand meanwhile", async () => {
    grants.set(String(BOARD), { relation: "owner", source: "idp" });
    ownerCount.mockResolvedValueOnce(2).mockResolvedValueOnce(0);

    await run(["staff"]);

    expect(updateOne).toHaveBeenLastCalledWith({ subject: USER._id, objectType: "project", object: BOARD, source: "idp" }, { $set: { relation: "owner" } });
    expect(logProjectAudit).not.toHaveBeenCalled();
  });

  it("records the change when the restore found a grant made by hand in the row's place, which it leaves alone", async () => {
    grants.set(String(BOARD), { relation: "owner", source: "idp" });
    ownerCount.mockResolvedValueOnce(2).mockResolvedValueOnce(0);
    deleteOne.mockResolvedValue({ deletedCount: 1 });
    updateOne.mockResolvedValue({ upsertedCount: 0, modifiedCount: 0 });

    await run(["other"]);
    expect(logProjectAudit).toHaveBeenCalledWith(db, String(BOARD), USER._id, "member_removed", expect.stringContaining("owner → no access"));

    logProjectAudit.mockClear();
    grants.set(String(BOARD), { relation: "owner", source: "idp" });
    ownerCount.mockResolvedValueOnce(2).mockResolvedValueOnce(0);
    updateOne.mockResolvedValueOnce({ upsertedCount: 0, modifiedCount: 1 }).mockResolvedValueOnce({ upsertedCount: 0, modifiedCount: 0 });
    await run(["staff"]);
    expect(logProjectAudit).toHaveBeenCalledWith(db, String(BOARD), USER._id, "member_role_changed", expect.stringContaining("owner → member"));
  });

  it("goes on to the next board when one fails, and never fails the sign-in", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    boards = [mapped(["staff", "member"]), { ...mapped(["staff", "member"]), _id: OTHER_BOARD, key: "OB" }];
    grants = new Map([[String(OTHER_BOARD), null]]);

    await expect(run(["staff"])).resolves.toBeUndefined();

    expect(error).toHaveBeenCalled();
    expect(updateOne).toHaveBeenCalledTimes(1);
    expect(updateOne.mock.calls[0][0].object).toEqual(OTHER_BOARD);
  });

  it("in the cloud needs the organisation's provider to be offered, which its plan decides", async () => {
    process.env.ORGANISATION_DOMAIN = "board.example";
    providerFor.mockResolvedValue(null);
    await run(["staff"]);
    expect(find).not.toHaveBeenCalled();

    providerFor.mockResolvedValue({ id: "oidc", own: true });
    await run(["staff"]);
    expect(find).toHaveBeenCalled();
  });
});
