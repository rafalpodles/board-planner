import { logInstanceAudit } from "@/lib/instanceAudit";
import { IUser } from "@/types";
import type { ScopedDb } from "@/lib/db-scope";
import { warnIfAdminsLockedOut } from "@/lib/password-sign-in";
import { organisationDomain } from "@/lib/organisation-host";
import { providerFor, type OidcProvider } from "@/lib/oidc/providers";

const ACTIVE_ADMINS = { role: "admin", deactivatedAt: null } as const;

export function adminGroup(): string | null {
  return process.env.OIDC_ADMIN_GROUP?.trim() || null;
}

let warnedMissingClaim = false;

/** The groups the generic OIDC provider's ID token names; none when the claim is missing. An organisation's own provider says which claim. */
export function groupsIn(claims: Record<string, unknown>, provider?: Pick<OidcProvider, "own" | "groupsClaim">): string[] {
  const claim = (provider?.own ? provider.groupsClaim : process.env.OIDC_GROUPS_CLAIM?.trim()) || "groups";
  const value = claims[claim];
  if (value === undefined && !provider?.own && adminGroup() && !warnedMissingClaim) {
    warnedMissingClaim = true;
    console.warn(`OIDC_ADMIN_GROUP is set but the ID token has no "${claim}" claim; its administrators are demoted`);
  }
  if (typeof value === "string") return [value];
  return Array.isArray(value) ? value.filter((g): g is string => typeof g === "string") : [];
}

/** Whether the ID token carries the groups claim at all: a token without it says nothing about a person's groups. */
export function hasGroupsClaim(claims: Record<string, unknown>, provider?: Pick<OidcProvider, "own" | "groupsClaim">): boolean {
  return claims[(provider?.own ? provider.groupsClaim : process.env.OIDC_GROUPS_CLAIM?.trim()) || "groups"] !== undefined;
}

/**
 * At each sign-in through the generic OIDC provider, `OIDC_ADMIN_GROUP` (in the cloud, the organisation's own admin
 * group) decides whether the account is an admin — never leaving no active admin. Nothing re-reads the group
 * between sign-ins.
 */
export async function applyAdminGroup(db: ScopedDb, user: IUser, providerId: string, groups: string[]): Promise<void> {
  if (providerId !== "oidc" || user.kind === "machine" || user.deactivatedAt) return;
  const group = organisationDomain() === null ? adminGroup() : ((await providerFor(db, "oidc"))?.adminGroup ?? null);
  if (!group) return;
  const member = groups.includes(group);

  if (member && user.role !== "admin") {
    const promoted = await db.User.updateOne({ _id: user._id, role: "member" }, { $set: { role: "admin" } });
    if (promoted.modifiedCount === 0) return;
    user.role = "admin";
    record(db, user, "member → admin", `in the identity provider's group ${group}`);
    return;
  }

  if (!member && user.role === "admin") {
    if ((await db.User.countDocuments(ACTIVE_ADMINS)) <= 1) return;
    const demoted = await db.User.updateOne({ _id: user._id, role: "admin" }, { $set: { role: "member" } });
    if (demoted.modifiedCount === 0) return;
    // Two last admins signing in at once each counted the other; one of them stays
    if ((await db.User.countDocuments(ACTIVE_ADMINS)) === 0) {
      await db.User.updateOne({ _id: user._id }, { $set: { role: "admin" } });
      return;
    }
    user.role = "member";
    record(db, user, "admin → member", `no longer in the identity provider's group ${group}`);
    void warnIfAdminsLockedOut(db, "an admin-group demotion");
  }
}

function record(db: ScopedDb, user: IUser, change: string, why: string) {
  void logInstanceAudit(db, {
    action: "user_role_changed",
    user: null,
    actorUsername: "",
    target: user.username,
    detail: `${change}, ${why}`,
  });
}
