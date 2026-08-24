import { IUser, GrantRelation } from "@/types";
import { connectDB } from "./db";
import { Grant } from "@/models/grant";
import { User } from "@/models/user";

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
  "role" | "tokenScoped" | "tokenScope" | "instanceAdminBeforeScope"
>;

/** An AccessSubject the grant store can be queried about. principalOf never needs the id. */
export type IdentifiedSubject = AccessSubject & Pick<IUser, "_id">;

export interface Principal {
  instanceAdmin: boolean;
  tokenScoped: boolean;
  tokenScope: string[] | null;
  instanceAdminBeforeScope: boolean;
}

export function decide(
  principal: Principal,
  grant: GrantRelation | null,
  need: Need,
  projectId: string
): boolean {
  if (principal.tokenScope && !principal.tokenScope.includes(projectId)) return false;
  if (need === "admin" && principal.tokenScoped) return false;
  if (principal.instanceAdmin || principal.instanceAdminBeforeScope) return true;
  if (grant === "owner") return true;
  return grant === "member" && need === "access";
}

export function principalOf(user: AccessSubject): Principal {
  return {
    instanceAdmin: user.role === "admin",
    tokenScoped: !!user.tokenScoped,
    tokenScope: user.tokenScope ? user.tokenScope.map(String) : null,
    instanceAdminBeforeScope: !!user.instanceAdminBeforeScope,
  };
}

export async function check(user: IdentifiedSubject, projectId: string, need: Need): Promise<boolean> {
  const principal = principalOf(user);
  // The query is skipped where no grant can change the verdict; the verdict itself always
  // comes from decide(), so the rule ordering lives in exactly one place.
  const withoutGrant =
    principal.instanceAdmin ||
    principal.instanceAdminBeforeScope ||
    (principal.tokenScope !== null && !principal.tokenScope.includes(projectId));
  if (withoutGrant) return decide(principal, null, need, projectId);

  await connectDB();
  const grant = await Grant.findOne({
    subject: user._id,
    objectType: "project",
    object: projectId,
  })
    .select("relation")
    .lean();

  return decide(principal, grant?.relation ?? null, need, projectId);
}

export async function accessibleProjectIds(user: IdentifiedSubject): Promise<string[] | null> {
  const principal = principalOf(user);
  if (principal.instanceAdmin || principal.instanceAdminBeforeScope) {
    return principal.tokenScope;
  }

  await connectDB();
  const grants = await Grant.find({ subject: user._id, objectType: "project" })
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
 * `kind: "machine"` account, which is why one never appears; the `pm` account is stored with the
 * default `kind: "human"` and is not covered by that refusal at all.
 */
export async function recipientsWithAccess(
  subjectIds: string[],
  projectId: string
): Promise<string[]> {
  if (subjectIds.length === 0) return [];

  await connectDB();
  const [grants, users] = await Promise.all([
    Grant.find({ subject: { $in: subjectIds }, objectType: "project", object: projectId })
      .select("subject relation")
      .lean(),
    User.find({ _id: { $in: subjectIds } }).select("role").lean(),
  ]);

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
    return decide(principalOf({ role }), relationOf.get(id) ?? null, "access", projectId);
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
  projectId: string
): Promise<Record<string, unknown>> {
  await connectDB();
  const grants = await Grant.find({ objectType: "project", object: projectId })
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
export async function canBeAssigned(userId: string, projectId: string): Promise<boolean> {
  return (await recipientsWithAccess([String(userId)], projectId)).length > 0;
}
