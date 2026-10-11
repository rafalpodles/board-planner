import type { Types } from "mongoose";
import type { ScopedDb } from "@/lib/db-scope";
import { ownerCount } from "@/lib/grants";
import { logInstanceAudit } from "@/lib/instanceAudit";
import { providerFor } from "@/lib/oidc/providers";
import { organisationDomain } from "@/lib/organisation-host";
import { logProjectAudit } from "@/lib/projectAudit";
import type { GrantRelation, GroupRole, IUser } from "@/types";

const RANK: Record<GrantRelation, number> = { member: 1, owner: 2 };

function wanted(map: GroupRole[], groups: string[]): GrantRelation | null {
  let best: GrantRelation | null = null;
  for (const { group, role } of map) {
    if (groups.includes(group) && (best === null || RANK[role] > RANK[best])) best = role;
  }
  return best;
}

/**
 * At each sign-in through the generic OIDC provider, the groups in the person's ID token decide which boards they hold a
 * grant on, by each board's own group mapping. Only grants the mapping made (`source: "idp"`) are ever changed or
 * removed: a grant somebody made by hand is theirs. A token with no groups claim at all says nothing, so it changes
 * nothing; and the last owner of a board is never demoted or removed. Nothing re-reads the groups between sign-ins.
 */
export async function applyGroupRoles(db: ScopedDb, user: IUser, providerId: string, groups: string[], groupsKnown: boolean | undefined): Promise<void> {
  if (providerId !== "oidc" || !groupsKnown || user.kind === "machine" || user.deactivatedAt) return;
  // In the cloud the groups come from the organisation's own provider, which it has only while its plan includes one
  if (organisationDomain() !== null && !(await providerFor(db, "oidc"))) return;

  const boards = await db.Project.find({ "groupRoleMap.0": { $exists: true } }).select("name key groupRoleMap").lean();
  for (const board of boards) {
    try {
      await reconcile(db, user, board, groups);
    } catch (err) {
      // One board's failure must not stop a person signing in, or the boards after it
      console.error(`Could not apply the group mapping of ${board.key} to ${user.username}:`, err);
    }
  }
}

async function reconcile(db: ScopedDb, user: IUser, board: { _id: Types.ObjectId; key: string; groupRoleMap?: GroupRole[] }, groups: string[]) {
  const want = wanted(board.groupRoleMap ?? [], groups);
  const where = { subject: user._id, objectType: "project" as const, object: board._id };
  const current = await db.Grant.findOne(where).select("relation source").lean();
  if (current && (current.source ?? "manual") !== "idp") return;

  const projectId = String(board._id);
  if (want && !current) {
    const made = await db.Grant.updateOne(where, { $setOnInsert: { relation: want, source: "idp", createdBy: null } }, { upsert: true });
    if (made.upsertedCount > 0) record(db, user, board, projectId, undefined, want, "member_added");
    return;
  }
  if (!current) return;
  if (want === current.relation) return;

  const losesOwner = current.relation === "owner" && want !== "owner";
  if (losesOwner && (await ownerCount(db, projectId)) <= 1) return;

  if (want) {
    const changed = await db.Grant.updateOne({ ...where, source: "idp" }, { $set: { relation: want } });
    if (changed.modifiedCount === 0) return;
  } else {
    const removed = await db.Grant.deleteOne({ ...where, source: "idp" });
    if (removed.deletedCount === 0) return;
  }
  // Two last owners signing in at once each counted the other: one of them stays. Only the mapping's own row is put
  // back: a grant somebody made by hand meanwhile is theirs, whatever it says
  if (losesOwner && (await ownerCount(db, projectId)) === 0) {
    if (want) await db.Grant.updateOne({ ...where, source: "idp" }, { $set: { relation: "owner" } });
    else await db.Grant.updateOne(where, { $setOnInsert: { relation: "owner", source: "idp", createdBy: null } }, { upsert: true });
    return;
  }
  record(db, user, board, projectId, current.relation, want ?? undefined, want ? "member_role_changed" : "member_removed");
}

function record(db: ScopedDb, user: IUser, board: { key: string }, projectId: string, from: GrantRelation | undefined, to: GrantRelation | undefined, action: "member_added" | "member_role_changed" | "member_removed") {
  const change = `${from ?? "no access"} → ${to ?? "no access"}`;
  void logProjectAudit(db, projectId, user._id as never, action, `${user.username}: ${change} (by the identity provider's group mapping)`);
  void logInstanceAudit(db, { action: "user_role_changed", user: null, actorUsername: "", target: user.username, detail: `${board.key}: ${change}, by the identity provider's group mapping` });
}
