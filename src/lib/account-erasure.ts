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

// A username inside a longer one ("al" in "alice", or in "al.k@example.com") is somebody else's name
const NAME_EDGE_BEFORE = "(?<![a-z0-9_.-])";
const NAME_EDGE_AFTER = "(?![a-z0-9_-]|[.@][a-z0-9])";

function nameMatcher(name: string): RegExp {
  return new RegExp(`${NAME_EDGE_BEFORE}${escapeRegExp(name)}${NAME_EDGE_AFTER}`, "gi");
}

export function scrubNames(text: string, names: string[], label: string): string {
  let out = text;
  // The address first: the username is a part of it
  for (const name of [...names].sort((a, b) => b.length - a.length)) out = out.replace(nameMatcher(name), label);
  return out;
}

// The two actions whose detail is "before → after" of something personal, old values included
const PERSONAL_CHANGE = /email_changed|full_name_changed/;
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
    // The detail is text only where it IS the person: their own change rows carry the old values, and
    // a confirmation carries their address. Anywhere else a word of it may be a role that shares their name.
    const detail = row.detail ?? "";
    if (aboutThem && (PERSONAL_CHANGE.test(row.action) || isThem(detail))) set.detail = label;
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
