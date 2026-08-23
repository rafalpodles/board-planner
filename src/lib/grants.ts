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
 * Machine identities are out of scope by construction: PUT /members refuses to grant a
 * `kind: "machine"` account, so a worker or the PM user can never satisfy this. They accumulate
 * watches by commenting and are filtered out here. Nothing reads a feed on their behalf today; if
 * something ever needs to tell a machine anything, this is the line that will refuse it.
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

  return subjectIds.filter((id) => {
    const role = roleOf.get(id);
    // No such user — deleted, or an id from a stale watcher list. Refused rather than resolved.
    if (!role) return false;
    // Only the stored fields: tokenScoped and its siblings are attached at request time by
    // applyTokenScope and can never be on a recipient loaded from the database.
    return decide(principalOf({ role }), relationOf.get(id) ?? null, "access", projectId);
  });
}
