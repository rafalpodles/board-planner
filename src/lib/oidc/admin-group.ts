import { logInstanceAudit } from "@/lib/instanceAudit";
import { User } from "@/models/user";
import { IUser } from "@/types";

const ACTIVE_ADMINS = { role: "admin", deactivatedAt: null } as const;

export function adminGroup(): string | null {
  return process.env.OIDC_ADMIN_GROUP?.trim() || null;
}

/** The groups the generic OIDC provider's ID token names; none when the claim is missing. */
export function groupsIn(claims: Record<string, unknown>): string[] {
  const value = claims[process.env.OIDC_GROUPS_CLAIM?.trim() || "groups"];
  if (typeof value === "string") return [value];
  return Array.isArray(value) ? value.filter((g): g is string => typeof g === "string") : [];
}

/**
 * The identity provider decides who administers: an account signing in through the generic OIDC
 * provider is an admin exactly while it is in `OIDC_ADMIN_GROUP` — never leaving no active admin.
 */
export async function applyAdminGroup(user: IUser, providerId: string, groups: string[]): Promise<void> {
  const group = adminGroup();
  if (!group || providerId !== "oidc" || user.kind === "machine" || user.deactivatedAt) return;
  const member = groups.includes(group);

  if (member && user.role !== "admin") {
    const promoted = await User.updateOne({ _id: user._id, role: "member" }, { $set: { role: "admin" } });
    if (promoted.modifiedCount === 0) return;
    user.role = "admin";
    record(user, "member → admin", `in the identity provider's group ${group}`);
    return;
  }

  if (!member && user.role === "admin") {
    if ((await User.countDocuments(ACTIVE_ADMINS)) <= 1) return;
    const demoted = await User.updateOne({ _id: user._id, role: "admin" }, { $set: { role: "member" } });
    if (demoted.modifiedCount === 0) return;
    // Two last admins signing in at once each counted the other; one of them stays
    if ((await User.countDocuments(ACTIVE_ADMINS)) === 0) {
      await User.updateOne({ _id: user._id }, { $set: { role: "admin" } });
      return;
    }
    user.role = "member";
    record(user, "admin → member", `no longer in the identity provider's group ${group}`);
  }
}

function record(user: IUser, change: string, why: string) {
  void logInstanceAudit({
    action: "user_role_changed",
    user: null,
    actorUsername: "",
    target: user.username,
    detail: `${change}, ${why}`,
  });
}
