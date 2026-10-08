import { NextResponse } from "next/server";
import type { ScopedDb } from "@/lib/db-scope";
import { getOrganisation } from "@/lib/organisation";
import { organisationDomain } from "@/lib/organisation-host";

export const FREE_MEMBER_LIMIT = 10;

export interface MemberCounts {
  active: number;
  pending: number;
}

/** People with access, and invitations that can still be accepted. Machines, the PM identity, workers and tokens are not people. */
export async function memberCounts(db: ScopedDb, now: number = Date.now()): Promise<MemberCounts> {
  const [active, pending] = await Promise.all([
    db.User.countDocuments({ kind: { $ne: "machine" }, deactivatedAt: null }),
    db.Invitation.countDocuments({ status: "pending", expiresAt: { $gt: new Date(now) } }),
  ]);
  return { active, pending };
}

/** Null where there is no limit: self-hosted, and any organisation on Pro or its trial. */
export async function memberLimitOf(db: ScopedDb): Promise<number | null> {
  if (organisationDomain() === null) return null;
  const organisation = await getOrganisation(db.organisation);
  return organisation.entitlements.plan === "pro" ? null : FREE_MEMBER_LIMIT;
}

/**
 * 402 when one more member would pass the limit, null when there is room. A pending invitation holds a
 * seat, so one for `email` already is that seat and is replaced rather than added.
 */
export async function memberLimitRefusal(db: ScopedDb, { email }: { email?: string } = {}): Promise<NextResponse | null> {
  const limit = await memberLimitOf(db);
  if (limit === null) return null;
  if (email && (await db.Invitation.exists({ email, status: "pending", expiresAt: { $gt: new Date() } }))) return null;
  const { active, pending } = await memberCounts(db);
  const held = active + pending;
  if (held < limit) return null;
  return NextResponse.json(
    {
      error: `This organisation is on the Free plan, which holds ${limit} members, and has ${held}${pending ? ` (${pending} invited)` : ""}. Upgrade to Pro to add more.`,
      feature: "members.limit",
      plan: "free",
      members: held,
      limit,
    },
    { status: 402 }
  );
}
