import type { Types } from "mongoose";
import { connectDB } from "@/lib/db";
import type { ScopedDb } from "@/lib/db-scope";

export interface ErasedAccount {
  _id: Types.ObjectId | string;
  username: string;
  email?: string;
  fullName?: string;
}

export function erasedLabel(userId: Types.ObjectId | string): string {
  return `deleted-${String(userId).slice(-8)}`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// A username inside a longer one ("al" in "alice") is somebody else's name
const NAME_EDGE_BEFORE = "(?<![a-z0-9_-])";
const NAME_EDGE_AFTER = "(?![a-z0-9_-])";

function nameMatcher(name: string): RegExp {
  return new RegExp(`${NAME_EDGE_BEFORE}${escapeRegExp(name)}${NAME_EDGE_AFTER}`, "gi");
}

export function scrubNames(text: string, names: string[], label: string): string {
  let out = text;
  for (const name of names) out = out.replace(nameMatcher(name), label);
  return out;
}

const SCRUBBED_AUDIT_FIELDS = ["actorUsername", "target", "detail"] as const;

async function scrubInstanceAudit(db: ScopedDb, user: ErasedAccount, names: string[], label: string) {
  const rows = await db.InstanceAuditLog.find({
    $or: [
      { user: user._id },
      { actorUsername: user.username },
      { target: user.username },
      { detail: { $regex: nameMatcher(user.username).source, $options: "i" } },
      ...(user.email ? [{ detail: { $regex: nameMatcher(user.email).source, $options: "i" } }] : []),
    ],
  })
    .select("actorUsername target detail")
    .lean();
  for (const row of rows) {
    const set: Record<string, string> = {};
    for (const field of SCRUBBED_AUDIT_FIELDS) {
      const before = (row as unknown as Record<string, string | undefined>)[field] ?? "";
      const after = scrubNames(before, names, label);
      if (after !== before) set[field] = after;
    }
    if (Object.keys(set).length > 0) await db.InstanceAuditLog.updateOne({ _id: row._id }, { $set: set });
  }
}

async function scrubProjectAudit(db: ScopedDb, user: ErasedAccount, names: string[], label: string) {
  const mentions = names.map((name) => ({ $regex: nameMatcher(name).source, $options: "i" }));
  const rows = await db.ProjectAuditLog.find({
    $or: mentions.flatMap((m) => [{ detail: m }, { lines: m }]),
  })
    .select("detail lines")
    .lean();
  for (const row of rows) {
    const detail = scrubNames(row.detail ?? "", names, label);
    const lines = (row.lines ?? []).map((line: string) => scrubNames(line, names, label));
    await db.ProjectAuditLog.updateOne({ _id: row._id }, { $set: { detail, ...(row.lines ? { lines } : {}) } });
  }
}

async function releaseMachinesOf(db: ScopedDb, user: ErasedAccount) {
  const workers = await db.Worker.find({ owner: user._id }).select("_id name identity").lean();
  for (const worker of workers) {
    await db.Worker.updateOne({ _id: worker._id }, { $set: { owner: null, enabled: false } });
    if (worker.identity && user.fullName) {
      const machine = await db.User.findById(worker.identity).select("fullName");
      if (machine?.fullName) {
        const prefix = `${user.fullName} · `;
        if (machine.fullName.startsWith(prefix)) {
          await db.User.updateOne({ _id: machine._id }, { $set: { fullName: machine.fullName.slice(prefix.length) } });
        }
      }
    }
  }
}

/**
 * What still names a person after their User row is gone: the rest of what an account leaves behind
 * is addressed to them or says what they said. Comments, tasks and history keep their content, which
 * belongs to the organisation's board — they only stop resolving to anybody.
 */
export async function eraseAccountTraces(db: ScopedDb, user: ErasedAccount): Promise<string> {
  await connectDB();
  const label = erasedLabel(user._id);
  const names = [user.username, ...(user.email ? [user.email] : [])];

  await db.Notification.deleteMany({ $or: [{ recipient: user._id }, { actor: user._id }] });
  await db.PmMessage.deleteMany({ triggeredBy: user._id });
  await db.OAuthConsent.deleteMany({ user: user._id });
  await db.Invitation.deleteMany({
    $or: [{ acceptedBy: user._id }, ...(user.email ? [{ email: user.email }] : [])],
  });

  // The assignee is written into history as a username, not as a reference
  await db.ActivityLog.updateMany({ field: "assignee", oldValue: user.username }, { $set: { oldValue: label } });
  await db.ActivityLog.updateMany({ field: "assignee", newValue: user.username }, { $set: { newValue: label } });

  await scrubInstanceAudit(db, user, names, label);
  await scrubProjectAudit(db, user, names, label);
  await releaseMachinesOf(db, user);
  return label;
}
