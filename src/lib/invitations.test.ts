import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createHash } from "crypto";

const findOneAndUpdate = vi.fn();
const findOne = vi.fn();
const updateOne = vi.fn();
const updateMany = vi.fn();
const create = vi.fn();

vi.mock("@/lib/db", () => ({ connectDB: vi.fn() }));
const authorityAtAcceptance = vi.fn();
vi.mock("./invitation-authority", () => ({ authorityAtAcceptance }));
vi.mock("@/models/invitation", () => ({
  Invitation: { findOneAndUpdate, findOne, updateOne, updateMany, create },
}));

const {
  issueInvitation,
  reissueInvitation,
  revokeInvitation,
  recordAcceptance,
  revokeClaimedInvitation,
  revokePendingInvitationsFor,
  inviteToBoard,
  removeBoardFromInvitation,
  revokeIfEmpty,
  recordDelivery,
  claimInvitation,
  findInvitationByToken,
  releaseInvitation,
  INVITATION_TOKEN_PREFIX,
  INVITATION_TTL_MS,
} = await import("./invitations");

const sha256 = (v: string) => createHash("sha256").update(v).digest("hex");
const duplicate = Object.assign(new Error("E11000"), { code: 11000 });
const ISSUE = { email: "ada@example.com", role: "member" as const, boards: [], invitedBy: "admin-1" };

function stored(row: unknown) {
  const lean = () => Promise.resolve(row);
  findOne.mockReturnValue({ lean, select: () => ({ lean }) });
}

beforeEach(() => {
  vi.clearAllMocks();
  findOneAndUpdate.mockResolvedValue({ _id: "inv-1", email: "ada@example.com" });
  stored(null);
  updateOne.mockResolvedValue({});
});

describe("issuing an invitation", () => {
  it("stores only the hash and hands back the one copy of the token", async () => {
    const { token } = await issueInvitation(ISSUE);

    expect(token.startsWith(INVITATION_TOKEN_PREFIX)).toBe(true);
    const update = findOneAndUpdate.mock.calls[0][1];
    expect(update.$set.tokenHash).toBe(sha256(token));
    expect(JSON.stringify(update)).not.toContain(token);
  });

  it("expires seven days out", async () => {
    const before = Date.now();
    await issueInvitation(ISSUE);

    const { expiresAt } = findOneAndUpdate.mock.calls[0][1].$set;
    expect(expiresAt.getTime()).toBeGreaterThanOrEqual(before + INVITATION_TTL_MS);
    expect(expiresAt.getTime()).toBeLessThanOrEqual(Date.now() + INVITATION_TTL_MS);
    expect(INVITATION_TTL_MS).toBe(7 * 24 * 60 * 60 * 1000);
  });

  it("replaces the address's pending invitation rather than adding a second one", async () => {
    await issueInvitation(ISSUE);

    const [filter, , options] = findOneAndUpdate.mock.calls[0];
    expect(filter).toEqual({ email: "ada@example.com", status: "pending" });
    expect(options).toMatchObject({ upsert: true });
  });

  it("records who added each board", async () => {
    await issueInvitation({ ...ISSUE, boards: [{ project: "p1", relation: "owner" }] });

    expect(findOneAndUpdate.mock.calls[0][1].$set.boards).toEqual([
      { project: "p1", relation: "owner", addedBy: "admin-1" },
    ]);
  });

  it("retries once when a concurrent upsert won the insert", async () => {
    findOneAndUpdate.mockRejectedValueOnce(duplicate);

    const { invitation } = await issueInvitation(ISSUE);

    expect(findOneAndUpdate).toHaveBeenCalledTimes(2);
    expect(invitation).toMatchObject({ _id: "inv-1" });
  });

  it("does not swallow any other failure", async () => {
    findOneAndUpdate.mockRejectedValueOnce(new Error("disk full"));

    await expect(issueInvitation(ISSUE)).rejects.toThrow("disk full");
  });
});

describe("sending again", () => {
  const BOARD_A = { project: "p-a", relation: "member", addedBy: "owner-a" };
  const BOARD_B = { project: "p-b", relation: "owner", addedBy: "owner-b" };

  beforeEach(() => {
    stored({ role: "member", boards: [BOARD_A, BOARD_B] });
    authorityAtAcceptance.mockResolvedValue({ role: "member", boards: [BOARD_A, BOARD_B] });
  });

  // BP-843. The resender re-endorses what is left, so what nobody can still grant goes first
  it("drops a board its adder can no longer grant before endorsing the rest", async () => {
    authorityAtAcceptance.mockResolvedValue({ role: "member", boards: [BOARD_A] });

    await reissueInvitation("inv-1", "admin-2");

    expect(authorityAtAcceptance).toHaveBeenCalledWith({ role: "member", boards: [BOARD_A, BOARD_B], invitedBy: "admin-2" });
    expect(updateOne).toHaveBeenCalledWith(
      { _id: "inv-1", status: "pending" },
      { $pull: { boards: { $or: [{ project: "p-b", addedBy: "owner-b" }] } } }
    );
    expect(updateOne.mock.invocationCallOrder[0]).toBeLessThan(findOneAndUpdate.mock.invocationCallOrder[0]);
  });

  it("pulls nothing while every board is still backed", async () => {
    await reissueInvitation("inv-1", "admin-2");

    expect(updateOne).not.toHaveBeenCalled();
  });

  it("changes the token, so the link mailed before stops working", async () => {
    const { token } = (await reissueInvitation("inv-1", "admin-2"))!;

    const [filter, update] = findOneAndUpdate.mock.calls[0];
    expect(filter).toEqual({ _id: "inv-1", status: "pending" });
    expect(update.$set.tokenHash).toBe(sha256(token));
  });

  it("starts the seven days again", async () => {
    const before = Date.now();
    await reissueInvitation("inv-1", "admin-2");

    expect(findOneAndUpdate.mock.calls[0][1].$set.expiresAt.getTime()).toBeGreaterThanOrEqual(
      before + INVITATION_TTL_MS
    );
  });

  // Acceptance checks the people an invitation names; a resent link naming a deleted inviter
  // would be refused after the invitee had filled in the form
  it("is endorsed by whoever sends it, for the role and every board", async () => {
    await reissueInvitation("inv-1", "admin-2");

    const { $set } = findOneAndUpdate.mock.calls[0][1];
    expect($set.invitedBy).toBe("admin-2");
    expect($set["boards.$[].addedBy"]).toBe("admin-2");
  });

  it("finds nothing to send for an invitation that is no longer pending", async () => {
    findOneAndUpdate.mockResolvedValue(null);

    expect(await reissueInvitation("inv-1", "admin-2")).toBeNull();
  });
});

describe("revoking", () => {
  it("revokes a pending invitation, and one whose acceptance has not produced an account yet", async () => {
    await revokeInvitation("inv-1");

    const [filter, update] = findOneAndUpdate.mock.calls[0];
    expect(filter).toEqual({
      _id: "inv-1",
      $or: [{ status: "pending" }, { status: "accepted", acceptedBy: null }],
    });
    expect(update).toEqual({ $set: { status: "revoked" } });
  });
});

describe("recording an acceptance", () => {
  it("ties the account only to a claim that is still held", async () => {
    updateOne.mockResolvedValue({ matchedCount: 1 });

    expect(await recordAcceptance("inv-1", "u1")).toBe(true);
    expect(updateOne.mock.calls[0]).toEqual([
      { _id: "inv-1", status: "accepted", acceptedBy: { $in: [null, "u1"] } },
      { $set: { acceptedBy: "u1" } },
    ]);
  });

  // BP-843. A retry after a write that landed but answered with an error must not read as the claim lost
  it("counts a claim already tied to this same account as held", async () => {
    updateOne.mockResolvedValue({ matchedCount: 1 });

    expect(await recordAcceptance("inv-1", "u1")).toBe(true);
    expect(updateOne.mock.calls[0][0].acceptedBy.$in).toContain("u1");
  });

  it("says so when the invitation was revoked meanwhile", async () => {
    updateOne.mockResolvedValue({ matchedCount: 0 });

    expect(await recordAcceptance("inv-1", "u1")).toBe(false);
  });
});

describe("spending the link", () => {
  afterEach(() => vi.useRealTimers());

  it("claims with one update that matches only a pending, unexpired invitation", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-02T12:00:00Z"));

    const outcome = await claimInvitation("cpi_abc");

    expect(outcome.ok).toBe(true);
    const [filter, update] = findOneAndUpdate.mock.calls[0];
    expect(filter).toEqual({
      tokenHash: sha256("cpi_abc"),
      status: "pending",
      expiresAt: { $gt: new Date("2026-10-02T12:00:00Z") },
    });
    expect(update.$set.status).toBe("accepted");
  });

  it.each([
    [null, "unknown"],
    [{ status: "accepted", expiresAt: new Date(Date.now() + 1000) }, "used"],
    [{ status: "revoked", expiresAt: new Date(Date.now() + 1000) }, "revoked"],
    [{ status: "pending", expiresAt: new Date(Date.now() - 1000) }, "expired"],
  ])("explains a refusal: %j is %s", async (row, reason) => {
    findOneAndUpdate.mockResolvedValue(null);
    stored(row);

    expect(await claimInvitation("cpi_abc")).toEqual({ ok: false, reason });
  });
});

describe("reading the link without spending it", () => {
  it("answers for a pending, unexpired invitation", async () => {
    stored({ status: "pending", expiresAt: new Date(Date.now() + 1000), email: "ada@example.com" });

    const found = await findInvitationByToken("cpi_abc");

    expect(found.ok).toBe(true);
    expect(findOneAndUpdate).not.toHaveBeenCalled();
  });

  it("refuses an expired one even though it is still marked pending", async () => {
    stored({ status: "pending", expiresAt: new Date(Date.now() - 1000) });

    expect(await findInvitationByToken("cpi_abc")).toEqual({ ok: false, reason: "expired" });
  });
});

describe("putting a claimed link back", () => {
  it("only reopens an acceptance that never produced an account, back to pending", async () => {
    await releaseInvitation("inv-1");

    expect(updateOne.mock.calls[0]).toEqual([
      { _id: "inv-1", status: "accepted", acceptedBy: null },
      { $set: { status: "pending", acceptedAt: null } },
    ]);
  });

  it("does not swallow any other failure", async () => {
    updateOne.mockRejectedValue(new Error("disk full"));

    await expect(releaseInvitation("inv-1")).rejects.toThrow("disk full");
  });

  it("leaves it spent when the address has been invited again since", async () => {
    updateOne.mockRejectedValue(duplicate);

    await expect(releaseInvitation("inv-1")).resolves.toBeUndefined();
  });
});

describe("revoking because nothing backs it any more", () => {
  // A lookup racing an acceptance in another tab must not kill the account being made
  it("revokes only pending invitations for an address", async () => {
    await revokePendingInvitationsFor("ada@example.com");

    expect(updateMany).toHaveBeenCalledWith(
      { email: "ada@example.com", status: "pending" },
      { $set: { status: "revoked" } }
    );
  });

  it("never throws: its callers are mid-way through security steps", async () => {
    updateMany.mockRejectedValue(new Error("write timeout"));

    await expect(revokePendingInvitationsFor("ada@example.com")).resolves.toBeUndefined();
  });

  it("does nothing for an account with no address", async () => {
    await revokePendingInvitationsFor("");

    expect(updateMany).not.toHaveBeenCalled();
  });

  it("revokes an acceptance's own claim and never a finished one", async () => {
    await revokeClaimedInvitation("inv-1");

    expect(updateOne).toHaveBeenCalledWith(
      { _id: "inv-1", status: "accepted", acceptedBy: null },
      { $set: { status: "revoked" } }
    );
  });
});

describe("a board owner inviting", () => {
  const INVITE = { email: "ada@example.com", project: "p1", relation: "owner" as const, invitedBy: "o1" };
  const JOINABLE = { $or: [{ deliveredAs: "email" }, { invitedBy: "o1" }] };

  beforeEach(() => {
    findOneAndUpdate.mockReset().mockResolvedValue(null);
    create.mockReset().mockImplementation(async (doc: Record<string, unknown>) => ({ _id: "inv-new", ...doc }));
    updateMany.mockReset().mockResolvedValue({});
    stored(null);
  });

  it("starts a member invitation for this board alone when none is pending", async () => {
    const outcome = await inviteToBoard(INVITE);

    expect(outcome.kind).toBe("created");
    const doc = create.mock.calls[0][0];
    expect(doc).toMatchObject({
      email: "ada@example.com",
      role: "member",
      boards: [{ project: "p1", relation: "owner", addedBy: "o1" }],
      invitedBy: "o1",
      status: "pending",
    });
    expect(outcome.kind === "created" && doc.tokenHash === sha256(outcome.token)).toBe(true);
  });

  // Somebody else's invitation: an owner may only add their board, never touch its role, its
  // link or how long it lives
  it("only adds this board to an invitation already pending, and changes nothing else", async () => {
    findOneAndUpdate.mockResolvedValueOnce(null).mockResolvedValueOnce({ _id: "inv-admin", role: "admin" });

    const outcome = await inviteToBoard(INVITE);

    expect(outcome.kind).toBe("added");
    expect(create).not.toHaveBeenCalled();
    const [filter, update] = findOneAndUpdate.mock.calls[1];
    expect(filter).toMatchObject({
      email: "ada@example.com",
      status: "pending",
      expiresAt: { $gt: expect.any(Date) },
      "boards.project": { $ne: "p1" },
      ...JOINABLE,
    });
    expect(update).toEqual({ $push: { boards: { project: "p1", relation: "owner", addedBy: "o1" } } });
  });

  it("re-relates this board's entry when it is already on the invitation, and says so", async () => {
    findOneAndUpdate.mockResolvedValueOnce({ _id: "inv-1" });

    const outcome = await inviteToBoard(INVITE);

    expect(outcome.kind).toBe("updated");
    const [filter, update] = findOneAndUpdate.mock.calls[0];
    expect(filter).toMatchObject({ email: "ada@example.com", status: "pending", "boards.project": "p1", ...JOINABLE });
    expect(update).toEqual({ $set: { "boards.$.relation": "owner", "boards.$.addedBy": "o1" } });
  });

  // A link handed to a person could be in anybody's hands; this board would go with it
  it("refuses to join an invitation whose link somebody else was shown", async () => {
    stored({ invitedBy: "a1", expiresAt: new Date(Date.now() + 60_000) });

    const outcome = await inviteToBoard(INVITE);

    expect(outcome).toEqual({ kind: "held", invitedBy: "a1", expired: false });
    expect(create).not.toHaveBeenCalled();
    // A pending invitation holds the address, lapsed or not (BP-843); a revoked or accepted one must not
    expect(findOne).toHaveBeenCalledWith({ email: "ada@example.com", status: "pending" });
  });

  it("says when the invitation holding the address has lapsed", async () => {
    stored({ invitedBy: "a1", expiresAt: new Date(Date.now() - 60_000) });

    expect(await inviteToBoard(INVITE)).toEqual({ kind: "held", invitedBy: "a1", expired: true });
  });

  it("retires its own expired invitation before looking for one to join", async () => {
    await inviteToBoard(INVITE);

    expect(updateMany).toHaveBeenCalledWith(
      { email: "ada@example.com", status: "pending", expiresAt: { $lte: expect.any(Date) }, invitedBy: INVITE.invitedBy },
      { $set: { status: "revoked" } }
    );
  });

  it("joins the invitation somebody else created a moment earlier", async () => {
    create.mockRejectedValueOnce(duplicate);
    findOneAndUpdate
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ _id: "inv-race" });

    const outcome = await inviteToBoard(INVITE);

    expect(outcome).toEqual({ kind: "added", invitation: { _id: "inv-race" } });
    expect(updateMany).toHaveBeenCalledTimes(2);
  });
});

describe("recording how a link went out", () => {
  it("never throws: the invitation has already gone out", async () => {
    updateOne.mockRejectedValueOnce(new Error("write timeout"));

    await expect(recordDelivery("inv-1", "cpi_abc", "link")).resolves.toBeUndefined();
  });

  it("ties the record to the link it describes", async () => {
    await recordDelivery("inv-1", "cpi_abc", "link");

    expect(updateOne).toHaveBeenCalledWith(
      { _id: "inv-1", tokenHash: sha256("cpi_abc") },
      { $set: { deliveredAs: "link" } }
    );
  });

  it("forgets it whenever a new link is issued", async () => {
    await issueInvitation(ISSUE);
    stored({ role: "member", boards: [] });
    authorityAtAcceptance.mockResolvedValue({ role: "member", boards: [] });
    await reissueInvitation("inv-1", "admin-2");

    expect(findOneAndUpdate.mock.calls[0][1].$set.deliveredAs).toBeNull();
    expect(findOneAndUpdate.mock.calls[1][1].$set.deliveredAs).toBeNull();
  });
});

describe("withdrawing a board from an invitation", () => {
  it("pulls only that board, only from a pending invitation that has it", async () => {
    findOneAndUpdate.mockResolvedValueOnce({ _id: "inv-1", boards: [] });

    await removeBoardFromInvitation("inv-1", "p1");

    expect(findOneAndUpdate.mock.calls.at(-1)!.slice(0, 2)).toEqual([
      { _id: "inv-1", status: "pending", "boards.project": "p1" },
      { $pull: { boards: { project: "p1" } } },
    ]);
  });

  // An administrator re-inviting the address lands on the same row with a new link and inviter
  it("revokes only the empty invitation it read, never a re-invite that landed since", async () => {
    updateOne.mockResolvedValue({ modifiedCount: 1 });

    const revoked = await revokeIfEmpty({ _id: "inv-1", invitedBy: "o1", tokenHash: "h1" } as never);

    expect(revoked).toBe(true);
    expect(updateOne).toHaveBeenCalledWith(
      { _id: "inv-1", status: "pending", boards: { $size: 0 }, invitedBy: "o1", tokenHash: "h1" },
      { $set: { status: "revoked" } }
    );
  });
});
