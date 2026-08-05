import { IUser, GrantRelation } from "@/types";

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
