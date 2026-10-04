import { Types, isValidObjectId } from "mongoose";
import { IUser, GrantRelation } from "@/types";
import { connectDB } from "./db";
import { organisationOf, type ScopedDb } from "@/lib/db-scope";

export type Need = "access" | "admin";

/**
 * The parts of a user an access decision actually reads.
 *
 * It buys no protection against a projection that forgets a field — `lean()` is typed without
 * regard to the projection string, so dropping `role` from the digest's query still compiles and
 * silently makes every instance admin look like a member. The test asserting that projection
 * contains `role` is what guards that, not this type. What it does buy is the ability to build a
 * principal from a batch query, which is how recipientsWithAccess reaches decide().
 */
export type AccessSubject = Pick<
  IUser,
  "role" | "tokenScoped" | "tokenScope" | "instanceAdminBeforeScope" | "organisation"
>;

/** An AccessSubject the grant store can be queried about. principalOf never needs the id. */
export type IdentifiedSubject = AccessSubject & Pick<IUser, "_id">;

export interface Principal {
  organisation: Types.ObjectId;
  instanceAdmin: boolean;
  tokenScoped: boolean;
  tokenScope: string[] | null;
  instanceAdminBeforeScope: boolean;
}

export interface ProjectRef {
  id: string;
  organisation: Types.ObjectId | null;
}

export function decide(
  principal: Principal,
  grant: GrantRelation | null,
  need: Need,
  project: ProjectRef
): boolean {
  if (!project.organisation || !principal.organisation.equals(project.organisation)) return false;
  const projectId = project.id;
  if (principal.tokenScope && !principal.tokenScope.includes(projectId)) return false;
  if (need === "admin" && principal.tokenScoped) return false;
  if (principal.instanceAdmin || principal.instanceAdminBeforeScope) return true;
  if (grant === "owner") return true;
  return grant === "member" && need === "access";
}

export function principalOf(user: AccessSubject): Principal {
  return {
    organisation: organisationOf(user),
    instanceAdmin: user.role === "admin",
    tokenScoped: !!user.tokenScoped,
    tokenScope: user.tokenScope ? user.tokenScope.map(String) : null,
    instanceAdminBeforeScope: !!user.instanceAdminBeforeScope,
  };
}

async function projectsInOrganisation(db: ScopedDb, projectIds: string[]): Promise<Set<string>> {
  const valid = projectIds.filter((id) => isValidObjectId(id));
  if (valid.length === 0) return new Set();
  await connectDB();
  const found = await db.Project.find({ _id: { $in: valid } }).select("_id").lean();
  return new Set(found.map((project) => String(project._id)));
}

const refOf = (db: ScopedDb, inOrganisation: Set<string>, id: string): ProjectRef => ({
  id,
  organisation: inOrganisation.has(id) ? db.organisation : null,
});

export async function check(db: ScopedDb, user: IdentifiedSubject, projectId: string, need: Need): Promise<boolean> {
  const principal = principalOf(user);
  if (!db.organisation.equals(principal.organisation)) return false;
  const project = refOf(db, await projectsInOrganisation(db, [String(projectId)]), String(projectId));
  // The query is skipped where no grant can change the verdict; the verdict itself always
  // comes from decide(), so the rule ordering lives in exactly one place.
  const withoutGrant =
    !project.organisation ||
    principal.instanceAdmin ||
    principal.instanceAdminBeforeScope ||
    (principal.tokenScope !== null && !principal.tokenScope.includes(projectId));
  if (withoutGrant) return decide(principal, null, need, project);

  const grant = await db.Grant.findOne({
    subject: user._id,
    objectType: "project",
    object: projectId,
  })
    .select("relation")
    .lean();

  return decide(principal, grant?.relation ?? null, need, project);
}

/**
 * Which of these projects this person may administer — check(db, user, id, "admin") for a list, in
 * one query rather than one per project.
 */
export async function administeredProjectIds(
  db: ScopedDb,
  user: IdentifiedSubject,
  projectIds: string[]
): Promise<Set<string>> {
  const ids = projectIds.map(String);
  const principal = principalOf(user);
  if (!db.organisation.equals(principal.organisation)) return new Set();
  const inOrganisation = await projectsInOrganisation(db, ids);
  const withoutGrant = principal.instanceAdmin || principal.instanceAdminBeforeScope;
  let relationOf = new Map<string, GrantRelation>();
  if (!withoutGrant && ids.length > 0) {
    await connectDB();
    const grants = await db.Grant.find({
      subject: user._id,
      objectType: "project",
      object: { $in: ids },
    })
      .select("object relation")
      .lean();
    relationOf = new Map(grants.map((g) => [String(g.object), g.relation]));
  }
  return new Set(
    ids.filter((id) => decide(principal, relationOf.get(id) ?? null, "admin", refOf(db, inOrganisation, id)))
  );
}

export async function accessibleProjectIds(db: ScopedDb, user: IdentifiedSubject): Promise<string[] | null> {
  const principal = principalOf(user);
  if (principal.instanceAdmin || principal.instanceAdminBeforeScope) {
    return principal.tokenScope;
  }

  await connectDB();
  const grants = await db.Grant.find({ subject: user._id, objectType: "project" })
    .select("object")
    .lean();

  const ids = grants.map((g) => String(g.object));
  return principal.tokenScope ? ids.filter((id) => principal.tokenScope!.includes(id)) : ids;
}

/**
 * Which of these people may still be told about this project.
 *
 * The verdict comes from decide(), the same as check() — a grant row is not the only source of
 * access, and a rule added there has to reach delivery too or somebody quietly stops being
 * notified. Batched rather than one check() per recipient because this runs on every notification
 * write.
 *
 * No `kind` check happens here, and none is implied: this asks the same question check() asks and
 * gets the same answer. In practice a worker identity holds no grant and is not an admin, so it is
 * refused — but by the ordinary rule, not by a special case. PUT /members does refuse to grant a
 * `kind: "machine"` account, which is why one never appears; the `pm` account is one too.
 */
export async function recipientsWithAccess(
  db: ScopedDb,
  subjectIds: string[],
  projectId: string
): Promise<string[]> {
  if (subjectIds.length === 0) return [];

  await connectDB();
  const [grants, users, inOrganisation] = await Promise.all([
    db.Grant.find({ subject: { $in: subjectIds }, objectType: "project", object: projectId })
      .select("subject relation")
      .lean(),
    // A deactivated account sees nothing, so it is told nothing and handed nothing (BP-832)
    db.User.find({ _id: { $in: subjectIds }, deactivatedAt: null }).select("role").lean(),
    projectsInOrganisation(db, [String(projectId)]),
  ]);
  const project = refOf(db, inOrganisation, String(projectId));

  const relationOf = new Map(grants.map((g) => [String(g.subject), g.relation]));
  const roleOf = new Map(users.map((u) => [String(u._id), u.role]));

  // Stringified on both sides, the way the maps are keyed: a caller handing over ObjectIds would
  // otherwise match nothing and lose every recipient silently.
  return subjectIds.filter((subjectId) => {
    const id = String(subjectId);
    const role = roleOf.get(id);
    // No such user — deleted, or an id from a stale watcher list. Refused rather than resolved.
    if (!role) return false;
    // Only the stored fields: tokenScoped and its siblings are attached at request time by
    // applyTokenScope and can never be on a recipient loaded from the database.
    return decide(principalOf({ role, organisation: db.organisation }), relationOf.get(id) ?? null, "access", project);
  });
}

/**
 * The same verdict decide() reaches, expressed as a query over stored users — for the one caller
 * that has to *select* an audience rather than filter a list it was handed.
 *
 * Only the stored halves of the rule are expressible here, and only those exist on a user loaded
 * from the database: tokenScoped and its siblings are attached at request time by applyTokenScope
 * and can never be on somebody read out of the collection. Both grant relations pass, because
 * `access` is what a member has too.
 *
 * It narrows, it does not decide. recipientsWithAccess still runs over whatever this returns, so
 * a rule added to decide() is enforced whether or not it was mirrored here.
 */
export async function projectAudienceFilter(
  db: ScopedDb,
  projectId: string
): Promise<Record<string, unknown>> {
  await connectDB();
  const grants = await db.Grant.find({ objectType: "project", object: projectId })
    .select("subject")
    .lean();

  return audienceFilterFrom(grants.map((g) => g.subject));
}

/**
 * The filter, for a caller that already holds the project's grant rows. Splitting it out is not
 * tidiness: /members reads those rows for the relation map anyway, and having it call
 * projectAudienceFilter meant querying the same collection twice per request.
 */
export function audienceFilterFrom(subjects: unknown[]): Record<string, unknown> {
  return { $or: [{ role: "admin" }, { _id: { $in: subjects } }] };
}

/**
 * Whether this person may be given work on this board.
 *
 * The same verdict decide() reaches, asked about somebody who is not the caller — so only their
 * stored fields exist, which is exactly what recipientsWithAccess reads. Delivery has checked this
 * since BP-328; assignment did not, so a task could be handed to somebody who would never hear
 * about it and could not open it.
 */
export async function canBeAssigned(db: ScopedDb, userId: string, projectId: string): Promise<boolean> {
  return (await recipientsWithAccess(db, [String(userId)], projectId)).length > 0;
}

export async function ownerCounts(db: ScopedDb, projectIds: string[]): Promise<Map<string, number>> {
  const counts = new Map(projectIds.map((id) => [String(id), 0]));
  if (projectIds.length === 0) return counts;

  await connectDB();
  const owners = await db.Grant.find({
    objectType: "project",
    relation: "owner",
    object: { $in: projectIds },
  })
    .select("subject object")
    .lean();
  // An owner who is deactivated manages nothing, so cannot be the owner that keeps a board run
  const holders = await db.User.find({ _id: { $in: owners.map((g) => g.subject) }, deactivatedAt: null })
    .select("_id")
    .lean();
  const living = new Set(holders.map((u) => String(u._id)));

  for (const grant of owners) {
    // A deleted account's leftover owner row is nobody who can manage the board
    if (!living.has(String(grant.subject))) continue;
    const board = String(grant.object);
    counts.set(board, (counts.get(board) ?? 0) + 1);
  }
  return counts;
}

export async function ownerCount(db: ScopedDb, projectId: string): Promise<number> {
  return (await ownerCounts(db, [projectId])).get(String(projectId)) ?? 0;
}

export interface OwnedBoard {
  _id: string;
  name: string;
  key: string;
}

export async function boardsOnlyOwnedBy(db: ScopedDb, userId: string): Promise<OwnedBoard[]> {
  await connectDB();
  // Never counted as an owner, so whatever they hold, the board keeps the owners it has (BP-832)
  if (await db.User.exists({ _id: userId, deactivatedAt: { $ne: null } })) return [];
  const owned = await db.Grant.find({ subject: userId, objectType: "project", relation: "owner" })
    .select("object")
    .lean();
  const counts = await ownerCounts(db, owned.map((g) => String(g.object)));
  const sole = [...counts].filter(([, owners]) => owners <= 1).map(([id]) => id);
  if (sole.length === 0) return [];

  const boards = await db.Project.find({ _id: { $in: sole } })
    .select("name key")
    .sort({ name: 1 })
    .lean();
  return boards.map((b) => ({ _id: String(b._id), name: b.name, key: b.key }));
}

/** Boards this person owns that have no active owner left, read after a deactivation (BP-832). */
export async function boardsLeftWithoutOwner(db: ScopedDb, userId: string): Promise<string[]> {
  await connectDB();
  const owned = await db.Grant.find({ subject: userId, objectType: "project", relation: "owner" })
    .select("object")
    .lean();
  const counts = await ownerCounts(db, owned.map((g) => String(g.object)));
  return [...counts].filter(([, owners]) => owners === 0).map(([id]) => id);
}

export interface OrphanGrant {
  _id: string;
  subject: string;
  object: string;
  relation: GrantRelation;
}

export interface OrphanGrants {
  deletedProject: OrphanGrant[];
  deletedUser: OrphanGrant[];
  notObjectIds: OrphanGrant[];
  projectCount: number;
  userCount: number;
}

type StoredGrant = { _id: unknown; subject: unknown; object: unknown; relation: GrantRelation };

function asOrphan(g: StoredGrant): OrphanGrant {
  return { _id: String(g._id), subject: String(g.subject), object: String(g.object), relation: g.relation };
}

// Grants before parents: every writer creates the parent first, so a parent made mid-scan is still seen
export async function findOrphanGrants(db: ScopedDb): Promise<OrphanGrants> {
  const grants: StoredGrant[] = await db.Grant.find({ objectType: "project" })
    .select("subject object relation")
    .lean();
  const [projectIds, userIds] = await Promise.all([db.Project.distinct("_id"), db.User.distinct("_id")]);
  const projects = new Set(projectIds.map(String));
  const users = new Set(userIds.map(String));

  const result: OrphanGrants = {
    deletedProject: [],
    deletedUser: [],
    notObjectIds: [],
    projectCount: projects.size,
    userCount: users.size,
  };
  for (const g of grants) {
    if (!(g.subject instanceof Types.ObjectId) || !(g.object instanceof Types.ObjectId)) {
      result.notObjectIds.push(asOrphan(g));
    } else if (!projects.has(String(g.object))) {
      result.deletedProject.push(asOrphan(g));
    } else if (!users.has(String(g.subject))) {
      result.deletedUser.push(asOrphan(g));
    }
  }
  return result;
}

export async function deleteOrphanGrants(db: ScopedDb, orphans: OrphanGrants): Promise<number> {
  if (orphans.projectCount === 0 || orphans.userCount === 0) {
    throw new Error(
      `Refusing to delete: this database has ${orphans.projectCount} project(s) and ` +
        `${orphans.userCount} user(s), which looks like the wrong database`
    );
  }
  const candidates = [...orphans.deletedProject, ...orphans.deletedUser];
  if (candidates.length === 0) return 0;

  const [projectIds, userIds] = await Promise.all([
    db.Project.distinct("_id", { _id: { $in: candidates.map((g) => g.object) } }),
    db.User.distinct("_id", { _id: { $in: candidates.map((g) => g.subject) } }),
  ]);
  const projects = new Set(projectIds.map(String));
  const users = new Set(userIds.map(String));
  const ids = candidates
    .filter((g) => !projects.has(g.object) || !users.has(g.subject))
    .map((g) => g._id);
  if (ids.length === 0) return 0;

  const { deletedCount } = await db.Grant.deleteMany({ _id: { $in: ids } });
  return deletedCount ?? 0;
}
