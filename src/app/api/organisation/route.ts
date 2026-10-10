import { NextResponse } from "next/server";
import { logInstanceAudit } from "@/lib/instanceAudit";
import { withAdmin, withAuth } from "@/lib/middleware";
import { checkOrganisationName, getOrganisation, organisationIsNamed, renameOrganisation } from "@/lib/organisation";
import { organisationDomain, organisationOrigin } from "@/lib/organisation-host";
import { memberCounts, memberLimitOf } from "@/lib/member-limit";
import type { ScopedDb } from "@/lib/db-scope";
import type { IOrganisation } from "@/models/organisation";

async function termsAcceptance(db: ScopedDb, organisation: IOrganisation) {
  if (!organisation.termsAcceptedVersion) return null;
  const by = organisation.termsAcceptedBy
    ? await db.User.findById(organisation.termsAcceptedBy).select("username fullName").lean()
    : null;
  return {
    version: organisation.termsAcceptedVersion,
    at: organisation.termsAcceptedAt?.toISOString() ?? null,
    by: by ? { username: by.username, fullName: by.fullName } : null,
  };
}

async function describe(db: ScopedDb, admin: boolean) {
  const [organisation, origin] = await Promise.all([getOrganisation(db.organisation), organisationOrigin(db.organisation)]);
  const counts = admin
    ? await Promise.all([
        db.Project.countDocuments({}),
        memberLimitOf(db),
        memberCounts(db),
      ])
    : null;
  const cloud = organisationDomain() !== null;
  return {
    name: organisation.name,
    named: organisationIsNamed(organisation),
    cloud,
    address: origin ? new URL(origin).host : null,
    plan: organisation.entitlements.plan,
    planEndsAt: organisation.entitlements.plan === "pro" ? organisation.entitlements.expiresAt?.toISOString() ?? null : null,
    trial: organisation.entitlements.plan === "pro" && organisation.entitlements.trial === true,
    subscription: organisation.entitlements.plan === "pro" ? organisation.entitlements.subscription ?? null : null,
    ...(counts ? { members: counts[2].active, projects: counts[0], memberLimit: counts[1], invited: counts[2].pending } : {}),
    ...(admin && cloud ? { termsAcceptance: await termsAcceptance(db, organisation) } : {}),
  };
}

export const GET = withAuth(async (_request, { user, db }) =>
  NextResponse.json(await describe(db, user.role === "admin"))
);

export const PUT = withAdmin(async (request, { user, db }) => {
  if (user.viaMachineCredential) {
    return NextResponse.json({ error: "Interactive admin session required" }, { status: 403 });
  }
  const body = await request.json().catch(() => null);
  const checked = checkOrganisationName(body?.name);
  if (!checked.ok) return NextResponse.json({ error: checked.error.replace(/^organisation/, "name") }, { status: 400 });
  if (!checked.value) return NextResponse.json({ error: "name is required" }, { status: 400 });

  const before = (await getOrganisation(db.organisation)).name;
  if (before !== checked.value) {
    await renameOrganisation(db.organisation, checked.value);
    void logInstanceAudit(db, {
      action: "organisation_renamed",
      user: user._id,
      actorUsername: user.username,
      detail: `${before} → ${checked.value}`,
    });
  }
  return NextResponse.json(await describe(db, true));
});
