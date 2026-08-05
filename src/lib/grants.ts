import { IUser, GrantRelation } from "@/types";
import { connectDB } from "./db";
import { Grant } from "@/models/grant";

export type Need = "access" | "admin";

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

export function principalOf(user: IUser): Principal {
  return {
    instanceAdmin: user.role === "admin",
    tokenScoped: !!user.tokenScoped,
    tokenScope: user.tokenScope ? user.tokenScope.map(String) : null,
    instanceAdminBeforeScope: !!user.instanceAdminBeforeScope,
  };
}

export async function check(user: IUser, projectId: string, need: Need): Promise<boolean> {
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

export async function accessibleProjectIds(user: IUser): Promise<string[] | null> {
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
