import { describe, it, expect, vi, beforeEach } from "vitest";

const countDocuments = vi.fn();
const find = vi.fn();
const deleteMany = vi.fn();
const updateOne = vi.fn();
const limit = vi.fn();
const sort = vi.fn();

vi.mock("@/models/oauthClient", () => ({ OAuthClient: { countDocuments, find, deleteMany, updateOne } }));

const { MAX_UNUSED_CLIENTS, UNUSED_CLIENT_TTL_MS, makeRoomForClient, markClientUsed, unusedClientExpiry } =
  await import("./oauth-clients");
const { scopedToDefaultOrganisation } = await import("@/lib/db-scope");
const { DEFAULT_ORGANISATION_ID } = await import("@/lib/organisation-field");

beforeEach(() => {
  vi.clearAllMocks();
  const chain = { sort, limit, select: () => chain, lean: () => Promise.resolve([{ _id: "old-1" }, { _id: "old-2" }]) };
  sort.mockReturnValue(chain);
  limit.mockReturnValue(chain);
  find.mockReturnValue(chain);
  deleteMany.mockResolvedValue({});
});

describe("making room for a registration (BP-1030)", () => {
  it("does nothing below the ceiling", async () => {
    countDocuments.mockResolvedValue(MAX_UNUSED_CLIENTS - 1);

    await makeRoomForClient(scopedToDefaultOrganisation());

    expect(find).not.toHaveBeenCalled();
    expect(deleteMany).not.toHaveBeenCalled();
  });

  it("counts and drops only clients nobody has approved, oldest first", async () => {
    countDocuments.mockResolvedValue(MAX_UNUSED_CLIENTS + 2);

    await makeRoomForClient(scopedToDefaultOrganisation());

    // Rows with no `expiresAt` — every approved client, and every one from before this existed —
    // are outside both the count and the delete
    expect(countDocuments.mock.calls[0][0].expiresAt.$gt).toBeInstanceOf(Date);
    expect(find.mock.calls[0][0].expiresAt.$gt).toBeInstanceOf(Date);
    expect(sort).toHaveBeenCalledWith({ createdAt: 1 });
    // The row about to be made counts too, so the surplus is one past what is over the ceiling
    expect(limit).toHaveBeenCalledWith(3);
    expect(deleteMany).toHaveBeenCalledWith(
      expect.objectContaining({ _id: { $in: ["old-1", "old-2"] }, expiresAt: { $gt: expect.any(Date) } })
    );
  });

  // A client approved between the read and the delete must keep its row, so the delete asserts the
  // row is still unapproved rather than trusting the ids
  it("makes the delete assert each row is still unapproved", async () => {
    countDocuments.mockResolvedValue(MAX_UNUSED_CLIENTS);

    await makeRoomForClient(scopedToDefaultOrganisation());

    expect(deleteMany.mock.calls[0][0].expiresAt).toEqual({ $gt: expect.any(Date) });
  });
});

describe("expiry and approval", () => {
  it("expires a registration after the TTL", () => {
    expect(unusedClientExpiry(1_000).getTime()).toBe(1_000 + UNUSED_CLIENT_TTL_MS);
  });

  it("removes the expiry when a person approves the client", async () => {
    updateOne.mockResolvedValue({});

    await markClientUsed(scopedToDefaultOrganisation(), "cpc_x");

    expect(updateOne).toHaveBeenCalledWith(
      { clientId: "cpc_x", organisation: DEFAULT_ORGANISATION_ID },
      { $unset: { expiresAt: 1 } }
    );
  });
});
