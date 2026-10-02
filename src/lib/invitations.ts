import { Types } from "mongoose";
import { connectDB } from "./db";
import { randomToken, sha256 } from "./oauth";
import { Invitation } from "@/models/invitation";
import { GrantRelation, IInvitation } from "@/types";

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
    Invitation.findOneAndUpdate(
      { email: input.email, status: "pending" },
      {
        $set: { role: input.role, boards, invitedBy: input.invitedBy, tokenHash, expiresAt },
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
  id: Types.ObjectId | string,
  sentBy: Types.ObjectId | string
): Promise<{ invitation: IInvitation; token: string } | null> {
  await connectDB();
  const { token, tokenHash, expiresAt } = freshSecret();
  const invitation = await Invitation.findOneAndUpdate(
    { _id: id, status: "pending" },
    { $set: { tokenHash, expiresAt, invitedBy: sentBy, "boards.$[].addedBy": sentBy } },
    { returnDocument: "after" }
  );
  return invitation ? { invitation, token } : null;
}

/** Also stops an acceptance in flight: its claim is not yet tied to an account, so it is revocable. */
export async function revokeInvitation(id: Types.ObjectId | string): Promise<IInvitation | null> {
  await connectDB();
  return Invitation.findOneAndUpdate(
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

export async function findInvitationByToken(token: string): Promise<InvitationOutcome> {
  await connectDB();
  const invitation = await Invitation.findOne({ tokenHash: sha256(token) }).lean<IInvitation>();
  if (invitation && invitation.status === "pending" && invitation.expiresAt > new Date()) {
    return { ok: true, invitation };
  }
  return { ok: false, reason: explain(invitation) };
}

/**
 * Spends the link. The claim is one update matching on `pending`, so two submissions arriving
 * together cannot both be told they won.
 */
export async function claimInvitation(token: string): Promise<InvitationOutcome> {
  await connectDB();
  const tokenHash = sha256(token);
  const now = new Date();
  const claimed = await Invitation.findOneAndUpdate(
    { tokenHash, status: "pending", expiresAt: { $gt: now } },
    { $set: { status: "accepted", acceptedAt: now } },
    { returnDocument: "after" }
  );
  if (claimed) return { ok: true, invitation: claimed };
  const existing = await Invitation.findOne({ tokenHash }).lean<IInvitation>();
  return { ok: false, reason: explain(existing) };
}

/** Puts a claimed link back, for an acceptance that could not finish — a username taken, say. */
export async function releaseInvitation(id: Types.ObjectId | string): Promise<void> {
  await connectDB();
  try {
    await Invitation.updateOne(
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
  id: Types.ObjectId | string,
  userId: Types.ObjectId | string
): Promise<boolean> {
  await connectDB();
  const result = await Invitation.updateOne(
    { _id: id, status: "accepted", acceptedBy: null },
    { $set: { acceptedBy: userId } }
  );
  return result.matchedCount === 1;
}

export async function markInvitationRevoked(id: Types.ObjectId | string): Promise<void> {
  await connectDB();
  await Invitation.updateOne({ _id: id }, { $set: { status: "revoked" } });
}
