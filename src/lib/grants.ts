import { IUser, GrantRelation } from "@/types";
import { connectDB } from "./db";
import { Grant } from "@/models/grant";
import { User } from "@/models/user";

export type Need = "access" | "admin";

export type AccessSubject = Pick<
  IUser,
  "role" | "tokenScoped" | "tokenScope" | "instanceAdminBeforeScope"
>;

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

  return subjectIds.filter((subjectId) => {
    const id = String(subjectId);
    const role = roleOf.get(id);
    if (!role) return false;
    return decide(principalOf({ role }), relationOf.get(id) ?? null, "access", projectId);
  });
}

export async function projectAudienceFilter(
  projectId: string
): Promise<Record<string, unknown>> {
  await connectDB();
  const grants = await Grant.find({ objectType: "project", object: projectId })
    .select("subject")
    .lean();

  return audienceFilterFrom(grants.map((g) => g.subject));
}

export function audienceFilterFrom(subjects: unknown[]): Record<string, unknown> {
  return { $or: [{ role: "admin" }, { _id: { $in: subjects } }] };
}

export async function canBeAssigned(userId: string, projectId: string): Promise<boolean> {
  return (await recipientsWithAccess([String(userId)], projectId)).length > 0;
}
