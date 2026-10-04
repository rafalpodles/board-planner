import { Types } from "mongoose";
import { connectDB } from "./db";
import { authorityAtAcceptance } from "./invitation-authority";
import { randomToken, sha256 } from "./oauth";
import { GrantRelation, IInvitation, IInvitationBoard } from "@/types";
import type { ScopedDb } from "@/lib/db-scope";

export const INVITATION_TOKEN_PREFIX = "cpi_";
export const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface InvitationBoardInput {
  project: Types.ObjectId | string;
  relation: GrantRelation;
}

export interface IssueInvitation {
  email: string;
  role: "admin" | "member";
  boards: InvitationBoardInput[];
  invitedBy: Types.ObjectId | string;
}

const DUPLICATE_KEY = 11000;

function freshSecret() {
  const token = randomToken(INVITATION_TOKEN_PREFIX);
  return { token, tokenHash: sha256(token), expiresAt: new Date(Date.now() + INVITATION_TTL_MS) };
}

/**
 * One pending invitation per address, replaced in place: inviting somebody again is the same
 * invitation with what the latest inviter chose, and the link mailed before stops working.
 */
export async function issueInvitation(
  db: ScopedDb,
  input: IssueInvitation
): Promise<{ invitation: IInvitation; token: string }> {
  await connectDB();
  const { token, tokenHash, expiresAt } = freshSecret();
  const boards = input.boards.map((b) => ({
    project: b.project,
    relation: b.relation,
    addedBy: input.invitedBy,
  }));
  const write = () =>
    db.Invitation.findOneAndUpdate(
      { email: input.email, status: "pending" },
      {
        $set: {
          role: input.role,
          boards,
          invitedBy: input.invitedBy,
          tokenHash,
          expiresAt,
          deliveredAs: null,
        },
        $setOnInsert: { email: input.email, status: "pending" },
      },
      { upsert: true, returnDocument: "after" }
    );
  let invitation: IInvitation | null;
  try {
    invitation = await write();
  } catch (err) {
    // Two concurrent upserts both missed; the unique index let one insert, so retry as an update
    if ((err as { code?: number }).code !== DUPLICATE_KEY) throw err;
    invitation = await write();
  }
  if (!invitation) throw new Error("invitation upsert returned nothing");
  return { invitation, token };
}

/**
 * A new link, endorsed by whoever sends it. Keeping the original inviter would mail a link that
 * acceptance refuses whenever that inviter has since been demoted or deleted.
 */
export async function reissueInvitation(
  db: ScopedDb,
  id: Types.ObjectId | string,
  sentBy: Types.ObjectId | string
): Promise<{ invitation: IInvitation; token: string; dropped: IInvitationBoard[] } | null> {
  await connectDB();
  // The resender re-endorses every board left, so a board its adder can no longer grant goes
  // first: otherwise the resend would grant it again without anybody choosing to (BP-843)
  const current = await db.Invitation.findOne({ _id: id, status: "pending" }).select("role boards").lean();
  if (!current) return null;
  const authority = await authorityAtAcceptance(db, { role: current.role, boards: current.boards, invitedBy: sentBy as Types.ObjectId });
  const backed = new Set((authority?.boards ?? []).map((b) => `${b.project}:${b.addedBy}`));
  // Only an adder who still exists and has lost the standing to grant it: one whose account was
  // deleted decided nothing about the board, and the resender takes it over as BP-826 did
  const lapsed = current.boards.filter((b) => !backed.has(`${b.project}:${b.addedBy}`));
  const stillThere = new Set(
    (await db.User.find({ _id: { $in: lapsed.map((b) => b.addedBy) } }).select("_id").lean()).map((u) => String(u._id))
  );
  const unbacked = lapsed.filter((b) => stillThere.has(String(b.addedBy)));
  if (unbacked.length > 0) {
    await db.Invitation.updateOne(
      { _id: id, status: "pending" },
      { $pull: { boards: { $or: unbacked.map((b) => ({ project: b.project, addedBy: b.addedBy })) } } }
    );
  }

  const { token, tokenHash, expiresAt } = freshSecret();
  const invitation = await db.Invitation.findOneAndUpdate(
    { _id: id, status: "pending" },
    {
      $set: {
        tokenHash,
        expiresAt,
        deliveredAs: null,
        invitedBy: sentBy,
        "boards.$[].addedBy": sentBy,
      },
    },
    { returnDocument: "after" }
  );
  // What the pull actually removed: a board re-related meanwhile by an owner who can grant it stayed
  const kept = new Set((invitation?.boards ?? []).map((b) => String(b.project)));
  return invitation ? { invitation, token, dropped: unbacked.filter((b) => !kept.has(String(b.project))) } : null;
}

/** Also stops an acceptance in flight: its claim is not yet tied to an account, so it is revocable. */
export async function revokeInvitation(db: ScopedDb, id: Types.ObjectId | string): Promise<IInvitation | null> {
  await connectDB();
  return db.Invitation.findOneAndUpdate(
    { _id: id, $or: [{ status: "pending" }, { status: "accepted", acceptedBy: null }] },
    { $set: { status: "revoked" } },
    { returnDocument: "after" }
  );
}

export type InvitationRefusal = "unknown" | "expired" | "used" | "revoked";
export type InvitationOutcome =
  | { ok: true; invitation: IInvitation }
  | { ok: false; reason: InvitationRefusal };

function explain(existing: Pick<IInvitation, "status" | "expiresAt"> | null): InvitationRefusal {
  if (!existing) return "unknown";
  if (existing.status === "accepted") return "used";
  if (existing.status === "revoked") return "revoked";
  return "expired";
}

export async function findInvitationByToken(db: ScopedDb, token: string): Promise<InvitationOutcome> {
  await connectDB();
  const invitation = await db.Invitation.findOne({ tokenHash: sha256(token) }).lean<IInvitation>();
  if (invitation && invitation.status === "pending" && invitation.expiresAt > new Date()) {
    return { ok: true, invitation };
  }
  return { ok: false, reason: explain(invitation) };
}

/**
 * Spends the link. The claim is one update matching on `pending`, so two submissions arriving
 * together cannot both be told they won.
 */
export async function claimInvitation(db: ScopedDb, token: string): Promise<InvitationOutcome> {
  return claimInvitationByHash(db, sha256(token));
}

export async function claimInvitationByHash(db: ScopedDb, tokenHash: string): Promise<InvitationOutcome> {
  await connectDB();
  const now = new Date();
  const claimed = await db.Invitation.findOneAndUpdate(
    { tokenHash, status: "pending", expiresAt: { $gt: now } },
    { $set: { status: "accepted", acceptedAt: now } },
    { returnDocument: "after" }
  );
  if (claimed) return { ok: true, invitation: claimed };
  const existing = await db.Invitation.findOne({ tokenHash }).lean<IInvitation>();
  return { ok: false, reason: explain(existing) };
}

/** Puts a claimed link back, for an acceptance that could not finish — a username taken, say. */
export async function releaseInvitation(db: ScopedDb, id: Types.ObjectId | string): Promise<void> {
  await connectDB();
  try {
    await db.Invitation.updateOne(
      { _id: id, status: "accepted", acceptedBy: null },
      { $set: { status: "pending", acceptedAt: null } }
    );
  } catch (err) {
    // The address was invited again meanwhile, and that newer invitation is the pending one now
    if ((err as { code?: number }).code !== DUPLICATE_KEY) throw err;
  }
}

/** False when the invitation was revoked while the account was being made. */
export async function recordAcceptance(
  db: ScopedDb,
  id: Types.ObjectId | string,
  userId: Types.ObjectId | string
): Promise<boolean> {
  await connectDB();
  // Already this account's counts too, so a retry after a write that landed but answered with an
  // error does not read as the claim lost and take the account back (BP-843)
  const result = await db.Invitation.updateOne(
    { _id: id, status: "accepted", acceptedBy: { $in: [null, userId] } },
    { $set: { acceptedBy: userId } }
  );
  return result.matchedCount === 1;
}

/** For an acceptance that found nothing still backing it: revokes its own claim, nothing else. */
export async function revokeClaimedInvitation(db: ScopedDb, id: Types.ObjectId | string): Promise<void> {
  await connectDB();
  await db.Invitation.updateOne(
    { _id: id, status: "accepted", acceptedBy: null },
    { $set: { status: "revoked" } }
  );
}

/**
 * Called wherever an account takes an address. Left pending, the invitation would come back to
 * life the day that account is deleted or moves away, granting what it said a week earlier.
 * Never throws: the callers are mid-way through security steps a failure here must not skip.
 */
export async function revokePendingInvitationsFor(db: ScopedDb, email: string): Promise<void> {
  if (!email) return;
  try {
    await connectDB();
    await db.Invitation.updateMany({ email, status: "pending" }, { $set: { status: "revoked" } });
  } catch (err) {
    console.error("Failed to withdraw pending invitations for an address:", err);
  }
}

/**
 * Matched on the token, so a delivery is never recorded against a link issued after it. Never
 * throws: the invitation has already gone out, and a row left unrecorded is merely unjoinable.
 */
export async function recordDelivery(
  db: ScopedDb,
  id: Types.ObjectId | string,
  token: string,
  deliveredAs: "email" | "link"
): Promise<void> {
  try {
    await connectDB();
    await db.Invitation.updateOne({ _id: id, tokenHash: sha256(token) }, { $set: { deliveredAs } });
  } catch (err) {
    console.error("Failed to record how an invitation was delivered:", err);
  }
}

export type BoardInvitation =
  | { kind: "created"; invitation: IInvitation; token: string }
  | { kind: "added" | "updated"; invitation: IInvitation }
  | { kind: "held"; invitedBy: Types.ObjectId; expired: boolean };

/**
 * A board owner's invitation. An invitation already pending for the address only gains (or
 * re-relates) this board's entry: its role, token and expiry are somebody else's to change, and a
 * fresh link handed to a non-admin could carry an administrator role.
 *
 * It joins only an invitation whose link went to the invited mailbox, or one this owner sent: a
 * link somebody was shown could be in anybody's hands, and this board would go wherever it does.
 */
export async function inviteToBoard(db: ScopedDb, input: {
  email: string;
  project: Types.ObjectId | string;
  relation: GrantRelation;
  invitedBy: Types.ObjectId | string;
}): Promise<BoardInvitation> {
  await connectDB();
  const { email, project, relation, invitedBy } = input;

  for (let attempt = 0; attempt < 2; attempt++) {
    const now = new Date();
    // Only this owner's own: another inviter's lapsed invitation, perhaps an administrator's with a
    // role and boards of its own, is theirs to resend or revoke, and holds the address meanwhile
    await db.Invitation.updateMany(
      { email, status: "pending", expiresAt: { $lte: now }, invitedBy },
      { $set: { status: "revoked" } }
    );
    const live: Record<string, unknown> = { email, status: "pending", expiresAt: { $gt: now } };
    const joinable: Record<string, unknown> = { ...live, $or: [{ deliveredAs: "email" }, { invitedBy }] };

    const updated = await db.Invitation.findOneAndUpdate(
      { ...joinable, "boards.project": project },
      { $set: { "boards.$.relation": relation, "boards.$.addedBy": invitedBy } },
      { returnDocument: "after" }
    );
    if (updated) return { kind: "updated", invitation: updated };
    const added = await db.Invitation.findOneAndUpdate(
      { ...joinable, "boards.project": { $ne: project } },
      { $push: { boards: { project, relation, addedBy: invitedBy } } },
      { returnDocument: "after" }
    );
    if (added) return { kind: "added", invitation: added };

    const held = await db.Invitation.findOne({ email, status: "pending" })
      .select("invitedBy expiresAt")
      .lean<{ invitedBy: Types.ObjectId; expiresAt: Date }>();
    if (held) return { kind: "held", invitedBy: held.invitedBy, expired: held.expiresAt <= now };

    const { token, tokenHash, expiresAt } = freshSecret();
    try {
      const invitation = await db.Invitation.create({
        email,
        role: "member",
        boards: [{ project, relation, addedBy: invitedBy }],
        invitedBy,
        tokenHash,
        expiresAt,
        status: "pending",
      });
      return { kind: "created", invitation, token };
    } catch (err) {
      // Somebody invited the address in between; the next pass looks at theirs
      if ((err as { code?: number }).code !== DUPLICATE_KEY) throw err;
    }
  }
  throw new Error("could not settle an invitation for that address");
}

/** Removes one board from a pending invitation. Null when it was not on one. */
export async function removeBoardFromInvitation(
  db: ScopedDb,
  id: Types.ObjectId | string,
  project: Types.ObjectId | string
): Promise<IInvitation | null> {
  await connectDB();
  return db.Invitation.findOneAndUpdate(
    { _id: id, status: "pending", "boards.project": project },
    { $pull: { boards: { project } } },
    { returnDocument: "after" }
  );
}

/**
 * Revokes an invitation left with no boards, and only the one read: matching its inviter and link
 * too keeps an administrator's re-invite, landing in between on the same row, from being revoked.
 */
export async function revokeIfEmpty(
  db: ScopedDb,
  invitation: Pick<IInvitation, "_id" | "invitedBy" | "tokenHash">
): Promise<boolean> {
  await connectDB();
  const result = await db.Invitation.updateOne(
    {
      _id: invitation._id,
      status: "pending",
      boards: { $size: 0 },
      invitedBy: invitation.invitedBy,
      tokenHash: invitation.tokenHash,
    },
    { $set: { status: "revoked" } }
  );
  return result.modifiedCount === 1;
}
