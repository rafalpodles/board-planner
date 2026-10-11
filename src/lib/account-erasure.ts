import { createHash, randomBytes } from "node:crypto";
import bcrypt from "bcryptjs";
import type { Types } from "mongoose";
import { connectDB } from "@/lib/db";
import type { ScopedDb } from "@/lib/db-scope";
import { organisationUploads } from "@/lib/upload-ownership";
import { workerDisplayName } from "@/lib/worker-user";

export interface ErasedAccount {
  _id: Types.ObjectId | string;
  username: string;
  email?: string;
}

export function erasedLabel(userId: Types.ObjectId | string): string {
  return `deleted-${createHash("sha256").update(String(userId)).digest("hex").slice(0, 8)}`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Actions about a person whose detail is theirs whole: old values of a change, an address confirmed
// earlier, the sentence a sign-up or an invitation wrote about them, the address a reset came from
const PERSONAL_DETAIL = /^(user_email_changed|user_email_confirmed|user_full_name_changed|user_created|user_password_reset_by_email|invitation_accepted)/;
// A target is a person only on these; elsewhere it is a machine, a board key or an organisation's slug
const PERSON_TARGET = /^(user_|invitation_)/;
const BOARD_ACCESS_ACTIONS = [
  "member_added",
  "member_role_changed",
  "member_removed",
  "member_invited",
  "member_invitation_removed",
] as const;

async function scrubInstanceAudit(db: ScopedDb, user: ErasedAccount, label: string) {
  const email = user.email ?? "";
  const rows = await db.InstanceAuditLog.find({
    $or: [
      { user: user._id },
      { actorUsername: user.username },
      { target: user.username },
      ...(email ? [{ target: email }] : []),
    ],
  })
    .select("action actorUsername target detail")
    .lean();

  const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
  const isThem = (value: string) => same(value, user.username) || (email !== "" && same(value, email));
  for (const row of rows) {
    const set: Record<string, string> = {};
    if (same(row.actorUsername ?? "", user.username)) set.actorUsername = label;
    const aboutThem = PERSON_TARGET.test(row.action) && isThem(row.target ?? "");
    if (aboutThem) set.target = label;
    // Whole or not at all: a word of free text may be a role that shares their name
    if (aboutThem && (PERSONAL_DETAIL.test(row.action) || isThem(row.detail ?? ""))) set.detail = label;
    if (Object.keys(set).length > 0) await db.InstanceAuditLog.updateOne({ _id: row._id }, { $set: set });
  }
}

// "<person>: viewer → editor" opens with whoever the grant was about, and is read only there:
// a role named "editor" or "viewer" elsewhere in the log is not a person
async function scrubBoardAccessAudit(db: ScopedDb, user: ErasedAccount, label: string) {
  const who = [user.username, ...(user.email ? [user.email] : [])].map(escapeRegExp).join("|");
  const rows = await db.ProjectAuditLog.find({
    action: { $in: [...BOARD_ACCESS_ACTIONS] },
    detail: { $regex: `^(?:${who}): `, $options: "i" },
  })
    .select("detail")
    .lean();
  const leading = new RegExp(`^(?:${who})(?=: )`, "i");
  for (const row of rows) {
    await db.ProjectAuditLog.updateOne({ _id: row._id }, { $set: { detail: (row.detail ?? "").replace(leading, label) } });
  }
}

async function releaseMachinesOf(db: ScopedDb, user: ErasedAccount) {
  const workers = await db.Worker.find({ owner: user._id }).select("_id name identity").lean();
  for (const worker of workers) {
    // The credential too: once the owner is gone, revoking "this owner's machines" no longer finds it
    const unmatchable = await bcrypt.hash(randomBytes(32).toString("hex"), 10);
    await db.Worker.updateOne({ _id: worker._id }, { $set: { owner: null, enabled: false, credentialHash: unmatchable } });
    // The machine's account is named after its owner and machine; the owner is the part that goes
    if (worker.identity) {
      await db.User.updateOne({ _id: worker.identity }, { $set: { fullName: workerDisplayName(worker.name, "") } });
    }
  }
}

async function deleteConversations(db: ScopedDb, user: ErasedAccount) {
  const messages = await db.PmMessage.find({ triggeredBy: user._id }).select("attachments").lean();
  const files = messages.flatMap((m) => (m.attachments ?? []).map((a: { fileId: string }) => a.fileId));
  // Only what this person uploaded: a message may name any file of its board, and the board keeps its own
  await organisationUploads(db)?.remove(files, String(user._id));
  await db.PmMessage.deleteMany({ triggeredBy: user._id });
}

/**
 * What still names a person after their User row is gone: the rest of what an account leaves behind
 * is addressed to them or says what they said. Comments, tasks and history keep their content, which
 * belongs to the organisation's board — they only stop resolving to anybody.
 */
export async function eraseAccountTraces(db: ScopedDb, user: ErasedAccount): Promise<string> {
  await connectDB();
  const label = erasedLabel(user._id);
  const quiet = { timestamps: false };

  await db.Notification.deleteMany({ $or: [{ recipient: user._id }, { actor: user._id }] });
  await deleteConversations(db, user);
  await db.OAuthConsent.deleteMany({ user: user._id });
  await db.Invitation.deleteMany({
    $or: [{ acceptedBy: user._id }, ...(user.email ? [{ email: user.email }] : [])],
  });

  // A reference to nobody reads as unassigned everywhere it is shown, so it is stored as that: the
  // dashboard, the assignee filter and "assign it again" otherwise disagree with the board
  await db.Task.updateMany({ assignee: user._id }, { $set: { assignee: null } }, quiet);
  await db.Task.updateMany({ assignedBy: user._id }, { $set: { assignedBy: null } }, quiet);
  await db.Task.updateMany({ pmAssignedFor: user._id }, { $set: { pmAssignedFor: null } }, quiet);
  await db.Task.updateMany({ watchers: user._id }, { $pull: { watchers: user._id } }, quiet);

  // The assignee is written into history as a username, not as a reference
  await db.ActivityLog.updateMany({ field: "assignee", oldValue: user.username }, { $set: { oldValue: label } });
  await db.ActivityLog.updateMany({ field: "assignee", newValue: user.username }, { $set: { newValue: label } });

  await scrubInstanceAudit(db, user, label);
  await scrubBoardAccessAudit(db, user, label);
  await releaseMachinesOf(db, user);
  return label;
}
