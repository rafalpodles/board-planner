import { NextResponse } from "next/server";
import { connectDB } from "@/lib/db";
import { logInstanceAudit } from "@/lib/instanceAudit";
import { entitlementRefusal, withAdmin } from "@/lib/middleware";
import { organisationDomain } from "@/lib/organisation-host";
import { readJsonBody } from "@/lib/request-body";
import { ssoView } from "@/lib/oidc/sso-view";

export const PUT = withAdmin(async (request, { user, db }) => {
  if (user.viaMachineCredential) return NextResponse.json({ error: "Interactive admin session required" }, { status: 403 });
  if (organisationDomain() === null) return NextResponse.json({ error: "Single sign-on is required per organisation in the cloud" }, { status: 404 });
  await connectDB();

  const read = await readJsonBody<{ enforced?: unknown }>(request);
  if (!read.ok) return read.response;
  if (typeof read.value.enforced !== "boolean") return NextResponse.json({ error: "enforced must be true or false" }, { status: 400 });
  const enforced = read.value.enforced;

  // Turning it off is always allowed, on any plan: it is the way back
  if (enforced) {
    const refusal = await entitlementRefusal(db, "identity.sso");
    if (refusal) return refusal;
    if (!(await db.Settings.exists({ sso: { $exists: true } }))) {
      return NextResponse.json({ error: "Set up your single sign-on provider first" }, { status: 400 });
    }
  }
  await db.Settings.updateOne({ sso: { $exists: true } }, { $set: { "sso.enforced": enforced } });
  void logInstanceAudit(db, {
    action: "instance_settings_changed",
    user: user._id,
    actorUsername: user.username,
    detail: `single sign-on: ${enforced ? "required of everybody" : "no longer required"}`,
  });
  return NextResponse.json(await ssoView(db));
});
