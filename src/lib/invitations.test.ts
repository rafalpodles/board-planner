import { describe, it, expect, vi, beforeEach } from "vitest";
import { createHash } from "crypto";

const findOneAndUpdate = vi.fn();
const findOne = vi.fn();
const updateOne = vi.fn();

vi.mock("@/lib/db", () => ({ connectDB: vi.fn() }));
vi.mock("@/models/invitation", () => ({
  Invitation: { findOneAndUpdate, findOne, updateOne },
}));

const {
  issueInvitation,
  reissueInvitation,
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
  findOne.mockReturnValue({ lean: () => Promise.resolve(row) });
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
  it("changes the token, so the link mailed before stops working", async () => {
    const { token } = (await reissueInvitation("inv-1"))!;

    const [filter, update] = findOneAndUpdate.mock.calls[0];
    expect(filter).toEqual({ _id: "inv-1", status: "pending" });
    expect(update.$set.tokenHash).toBe(sha256(token));
  });

  it("finds nothing to send for an invitation that is no longer pending", async () => {
    findOneAndUpdate.mockResolvedValue(null);

    expect(await reissueInvitation("inv-1")).toBeNull();
  });
});

describe("spending the link", () => {
  it("claims with one update that matches only a pending, unexpired invitation", async () => {
    const outcome = await claimInvitation("cpi_abc");

    expect(outcome.ok).toBe(true);
    const [filter, update] = findOneAndUpdate.mock.calls[0];
    expect(filter.tokenHash).toBe(sha256("cpi_abc"));
    expect(filter.status).toBe("pending");
    expect(filter.expiresAt.$gt).toBeInstanceOf(Date);
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
  it("only reopens an acceptance that never produced an account", async () => {
    await releaseInvitation("inv-1");

    expect(updateOne.mock.calls[0][0]).toEqual({ _id: "inv-1", status: "accepted", acceptedBy: null });
  });

  it("leaves it spent when the address has been invited again since", async () => {
    updateOne.mockRejectedValue(duplicate);

    await expect(releaseInvitation("inv-1")).resolves.toBeUndefined();
  });
});
