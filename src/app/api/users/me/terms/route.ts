import { NextResponse } from "next/server";
import { withAuth } from "@/lib/middleware";
import { readJsonBody } from "@/lib/request-body";
import { legalTermsVersion } from "@/lib/legal-terms";
import { logInstanceAudit } from "@/lib/instanceAudit";

/** The person dismissed the notice of changed terms: recorded as seen, which is not an acceptance */
export const POST = withAuth(async (request, { user, db }) => {
  if (user.viaMachineCredential || user.kind === "machine") {
    return NextResponse.json({ error: "Only a person, signed in, can be told of the terms" }, { status: 403 });
  }
  const version = legalTermsVersion();
  if (!version) return NextResponse.json({ error: "This instance publishes no terms" }, { status: 404 });
  const read = await readJsonBody<{ version?: unknown }>(request);
  if (!read.ok) return read.response;
  if (read.value.version !== version) {
    return NextResponse.json({ error: "The terms changed again since this page loaded. Reload it.", version }, { status: 409 });
  }
  const termsNotifiedAt = new Date();
  await db.User.updateOne({ _id: user._id }, { $set: { termsNotifiedVersion: version, termsNotifiedAt } });
  void logInstanceAudit(db, {
    action: "terms_change_seen",
    user: user._id,
    actorUsername: user.username,
    target: user.username,
    detail: user.termsAcceptedVersion ? `the terms of ${version}, accepted ${user.termsAcceptedVersion}` : `the terms of ${version}`,
  });
  return NextResponse.json({ termsNotifiedVersion: version, termsNotifiedAt: termsNotifiedAt.toISOString() });
});
