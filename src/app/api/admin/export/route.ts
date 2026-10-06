import { NextResponse } from "next/server";
import { logInstanceAudit } from "@/lib/instanceAudit";
import { withAdmin } from "@/lib/middleware";
import { getOrganisation } from "@/lib/organisation";
import { organisationExportResponse } from "@/lib/organisation-export-response";

export const GET = withAdmin(async (request, { user, db }) => {
  if (user.viaMachineCredential) {
    return NextResponse.json({ error: "Interactive admin session required" }, { status: 403 });
  }
  if (new URL(request.url).searchParams.get("check") === "1") return new NextResponse(null, { status: 204 });
  const slug = (await getOrganisation(db.organisation)).slug ?? "organisation";
  return organisationExportResponse(db, slug, () =>
    logInstanceAudit(db, { action: "organisation_exported", user: user._id, actorUsername: user.username, target: slug }, { strict: true })
  );
});
