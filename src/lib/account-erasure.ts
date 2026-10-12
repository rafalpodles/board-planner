import { createHash, randomBytes } from "node:crypto";
import bcrypt from "bcryptjs";
import { Types } from "mongoose";
import { connectDB } from "@/lib/db";
import type { ScopedDb } from "@/lib/db-scope";
import { organisationUploads } from "@/lib/upload-ownership";
import { workerDisplayName } from "@/lib/worker-user";
import { DELETED_AGENT } from "@/types";

type Id = Types.ObjectId | string;

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

async function releaseMachinesOf(db: ScopedDb, userId: Id) {
  const workers = await db.Worker.find({ owner: userId }).select("_id name identity").lean();
  for (const worker of workers) {
    // The machine's account is named after its owner and machine; the owner is the part that goes.
    // Before the machine is released, which is what finds it again if this stops half way
    if (worker.identity) {
      await db.User.updateOne({ _id: worker.identity }, { $set: { fullName: workerDisplayName(worker.name, "") } });
    }
    // The credential too: once the owner is gone, revoking "this owner's machines" no longer finds it
    const unmatchable = await bcrypt.hash(randomBytes(32).toString("hex"), 10);
    await db.Worker.updateOne({ _id: worker._id }, { $set: { owner: null, enabled: false, credentialHash: unmatchable } });
  }
}

async function deleteConversations(db: ScopedDb, userId: Id) {
  const messages = await db.PmMessage.find({ triggeredBy: userId }).select("attachments").lean();
  const files = messages.flatMap((m) => (m.attachments ?? []).map((a: { fileId: string }) => a.fileId));
  // Only what this person uploaded: a message may name any file of its board, and the board keeps its own
  await organisationUploads(db)?.remove(files, String(userId));
  await db.PmMessage.deleteMany({ triggeredBy: userId });
}

// An occurrence copies its predecessor's agent with no row of its own, so one that somebody else then
// cleared is reachable only through the series it belongs to
async function withTheirRecurrenceChain(db: ScopedDb, start: Types.ObjectId[]): Promise<Types.ObjectId[]> {
  const found = new Map<string, Types.ObjectId>(start.map((id) => [String(id), id]));
  // Each round asks only about what the last one found, and the set only grows, so a series of any
  // length ends, and so does one whose parent links loop
  let frontier = [...found.values()];
  while (frontier.length > 0) {
    const [children, parents] = await Promise.all([
      db.Task.distinct("_id", { recurringParentId: { $in: frontier } }),
      db.Task.distinct("recurringParentId", { _id: { $in: frontier } }),
    ]);
    frontier = [];
    for (const id of [...children, ...parents] as Types.ObjectId[]) {
      if (id && !found.has(String(id))) {
        found.set(String(id), id);
        frontier.push(id);
      }
    }
  }
  return [...found.values()];
}

// A personal agent runs only on its owner's own tasks, so with the owner gone it has no one to run for,
// and its name and prompts are what they wrote. History stores the name as it was when the change was
// made (BP-730), so a renamed agent is in it under several. Only the owner can point a task at a
// personal agent, so the rows are on the tasks where they changed an agent or that still carry one of
// theirs (a recurring task's next occurrence copies it with no row of its own). On those, a value that
// is not the name of an agent that still exists is a deleted agent's: it says so instead. The agent
// goes last: a retry after a stop half way still finds the rows.
async function removePersonalAgentsOf(db: ScopedDb, userId: Id, quiet: { timestamps: false }) {
  const agents = await db.Agent.find({ scope: "user", owner: userId }).select("_id").lean();
  if (agents.length === 0) return;
  const ids = agents.map((a) => a._id);
  const going = new Set(ids.map(String));

  const [changed, carrying, everyAgent] = await Promise.all([
    db.ActivityLog.distinct("task", { field: "agent", user: userId }),
    db.Task.distinct("_id", { agent: { $in: ids } }),
    db.Agent.find({}).select("name").lean(),
  ]);
  const staying = everyAgent.filter((a) => !going.has(String(a._id)));
  const kept = ["", DELETED_AGENT, ...staying.map((a) => a.name as string), ...staying.map((a) => String(a._id))];

  const tasks = await withTheirRecurrenceChain(db, [...changed, ...carrying]);
  if (tasks.length > 0) {
    // Not a custom field that happens to be called "agent"
    const rows = { field: "agent", customField: { $ne: true }, task: { $in: tasks } };
    await db.ActivityLog.updateMany({ ...rows, oldValue: { $nin: kept } }, { $set: { oldValue: DELETED_AGENT } });
    await db.ActivityLog.updateMany({ ...rows, newValue: { $nin: kept } }, { $set: { newValue: DELETED_AGENT } });
  }
  await db.Task.updateMany({ agent: { $in: ids } }, { $set: { agent: null } }, quiet);
  await db.AgentRun.updateMany({ agent: { $in: ids } }, { $set: { agent: null, agentName: DELETED_AGENT } }, quiet);
  await db.Agent.deleteMany({ _id: { $in: ids } });
}

/**
 * What still points at a user id after the User row is gone, keyed by the id alone: what is addressed to
 * them, what they said to the PM agent, what they authored. Not their machines, which go last, nor what
 * names them by username or address, which an id cannot find. Run for an account being deleted and, by
 * the clean-up script, for ids an earlier deletion left behind. Safe to run again.
 */
export async function eraseReferencesTo(db: ScopedDb, userId: Id): Promise<void> {
  await connectDB();
  const quiet = { timestamps: false } as const;

  await db.Notification.deleteMany({ $or: [{ recipient: userId }, { actor: userId }] });
  await deleteConversations(db, userId);
  await db.OAuthConsent.deleteMany({ user: userId });
  await db.Invitation.deleteMany({ acceptedBy: userId });

  // A reference to nobody reads as unassigned everywhere it is shown, so it is stored as that: the
  // dashboard, the assignee filter and "assign it again" otherwise disagree with the board
  await db.Task.updateMany({ assignee: userId }, { $set: { assignee: null } }, quiet);
  await db.Task.updateMany({ assignedBy: userId }, { $set: { assignedBy: null } }, quiet);
  await db.Task.updateMany({ pmAssignedFor: userId }, { $set: { pmAssignedFor: null } }, quiet);
  await db.Task.updateMany({ watchers: userId }, { $pull: { watchers: userId } }, quiet);

  await removePersonalAgentsOf(db, userId, quiet);
  // Blocks are the organisation's catalogue and who may edit one is the role, never this field
  await db.AgentBlock.updateMany({ createdBy: userId }, { $set: { createdBy: null } }, quiet);
}

/**
 * What still names a person after their User row is gone: the rest of what an account leaves behind
 * is addressed to them or says what they said. Comments, tasks and history keep their content, which
 * belongs to the organisation's board — they only stop resolving to anybody.
 */
export async function eraseAccountTraces(db: ScopedDb, user: ErasedAccount): Promise<string> {
  await connectDB();
  const label = erasedLabel(user._id);

  await eraseReferencesTo(db, user._id);
  if (user.email) await db.Invitation.deleteMany({ email: user.email });

  // The assignee is written into history as a username, not as a reference
  await db.ActivityLog.updateMany({ field: "assignee", oldValue: user.username }, { $set: { oldValue: label } });
  await db.ActivityLog.updateMany({ field: "assignee", newValue: user.username }, { $set: { newValue: label } });

  await scrubInstanceAudit(db, user, label);
  await scrubBoardAccessAudit(db, user, label);
  // Last: it locks the machines out of their owner, so a failure before it leaves an account that
  // stays with the machines it had
  await releaseMachinesOf(db, user._id);
  return label;
}

export const ORPHAN_SOURCES = [
  ["Task", "assignee"],
  ["Task", "assignedBy"],
  ["Task", "pmAssignedFor"],
  ["Task", "watchers"],
  ["Notification", "recipient"],
  ["Notification", "actor"],
  ["PmMessage", "triggeredBy"],
  ["OAuthConsent", "user"],
  ["Invitation", "acceptedBy"],
  ["Worker", "owner"],
  ["Agent", "owner"],
  ["AgentBlock", "createdBy"],
] as const;

export interface OrphanReferences {
  ids: string[];
  bySource: Record<string, number>;
  userCount: number;
}

// References before users: a person created mid-scan and named at once is still in the user list
export async function findOrphanReferences(db: ScopedDb): Promise<OrphanReferences> {
  const referenced = new Map<string, string[]>();
  for (const [model, field] of ORPHAN_SOURCES) {
    const values: unknown[] = await (db[model] as unknown as { distinct(f: string): Promise<unknown[]> }).distinct(field);
    for (const value of values) {
      if (!(value instanceof Types.ObjectId)) continue;
      const sources = referenced.get(String(value)) ?? [];
      sources.push(`${model}.${field}`);
      referenced.set(String(value), sources);
    }
  }
  const users = new Set((await db.User.distinct("_id")).map(String));

  const result: OrphanReferences = { ids: [], bySource: {}, userCount: users.size };
  for (const [id, sources] of referenced) {
    if (users.has(id)) continue;
    result.ids.push(id);
    for (const source of sources) result.bySource[source] = (result.bySource[source] ?? 0) + 1;
  }
  return result;
}

export async function eraseOrphanReferences(db: ScopedDb, orphans: OrphanReferences): Promise<number> {
  if (orphans.userCount === 0) {
    throw new Error("Refusing to erase: this database has no users, which looks like the wrong database");
  }
  let erased = 0;
  for (const id of orphans.ids) {
    // Asked again, one at a time, so an account that appeared since the scan is never treated as gone
    if (await db.User.findById(id).select("_id").lean()) continue;
    await eraseReferencesTo(db, id);
    await releaseMachinesOf(db, id);
    erased += 1;
  }
  return erased;
}
