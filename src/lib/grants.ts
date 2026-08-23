import { IUser, GrantRelation } from "@/types";
import { connectDB } from "./db";
import { Grant } from "@/models/grant";
import { User } from "@/models/user";

export type Need = "access" | "admin";

/**
 * The parts of a user an access decision actually reads. Narrower than IUser so a lean projection
 * — the digest loads `email username role` — can be asked about without a cast that would turn
 * type checking off at exactly the point access is decided.
 */
export type AccessSubject = Pick<IUser, "_id" | "role"> &
  Partial<Pick<IUser, "tokenScoped" | "tokenScope" | "instanceAdminBeforeScope">>;

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

export async function check(user: AccessSubject, projectId: string, need: Need): Promise<boolean> {
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

export async function accessibleProjectIds(user: AccessSubject): Promise<string[] | null> {
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
 * Which of these people may still be told about this project. Access is a grant row OR instance
 * admin — an admin reaches every board without one ever being written, so filtering on grants
 * alone would silently stop notifying them.
 */
export async function recipientsWithAccess(
  subjectIds: string[],
  projectId: string
): Promise<string[]> {
  if (subjectIds.length === 0) return [];

  await connectDB();
  const [grants, admins] = await Promise.all([
    Grant.find({ subject: { $in: subjectIds }, objectType: "project", object: projectId })
      .select("subject")
      .lean(),
    User.find({ _id: { $in: subjectIds }, role: "admin" }).select("_id").lean(),
  ]);

  const allowed = new Set([
    ...grants.map((g) => String(g.subject)),
    ...admins.map((u) => String(u._id)),
  ]);
  return subjectIds.filter((id) => allowed.has(String(id)));
}
