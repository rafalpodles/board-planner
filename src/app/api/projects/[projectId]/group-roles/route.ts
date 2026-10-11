import { NextResponse } from "next/server";
import { connectDB } from "@/lib/db";
import { parseGroupRoleMap } from "@/lib/group-role-map";
import { entitlementRefusal, withProjectOwner } from "@/lib/middleware";
import { providersFor } from "@/lib/oidc/providers";
import { organisationDomain } from "@/lib/organisation-host";
import { logProjectAudit } from "@/lib/projectAudit";
import { readJsonBody } from "@/lib/request-body";

/**
 * Which identity provider groups give which role on this board. Whether there is a provider whose groups it could
 * read is part of the answer, so the page can leave the card out where there is nothing to map.
 */
export const GET = withProjectOwner(async (_request, { params, db }) => {
  await connectDB();
  const { projectId } = await params;
  const project = await db.Project.findById(projectId).select("groupRoleMap").lean();
  const hasProvider = (await providersFor(db)).some((p) => p.id === "oidc");
  return NextResponse.json({ map: (project?.groupRoleMap ?? []).map(({ group, role }) => ({ group, role })), hasProvider });
});

export const PUT = withProjectOwner(async (request, { params, user, db }) => {
  await connectDB();
  const { projectId } = await params;
  const read = await readJsonBody<unknown>(request);
  if (!read.ok) return read.response;
  const parsed = parseGroupRoleMap(read.value);
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });

  // In the cloud the groups come from the organisation's own provider, which is part of Pro
  if (organisationDomain() !== null) {
    const refusal = await entitlementRefusal(db, "identity.sso");
    if (refusal) return refusal;
  }
  if (parsed.value.length > 0 && !(await providersFor(db)).some((p) => p.id === "oidc")) {
    return NextResponse.json({ error: "Set up an OpenID Connect provider first: groups come from its ID token" }, { status: 400 });
  }

  const updated = await db.Project.updateOne({ _id: projectId }, { $set: { groupRoleMap: parsed.value } });
  if (updated.matchedCount === 0) return NextResponse.json({ error: "Project not found" }, { status: 404 });
  void logProjectAudit(
    db,
    projectId,
    String(user._id),
    "settings_updated",
    `Group roles: ${parsed.value.length ? parsed.value.map(({ group, role }) => `${group} → ${role}`).join(", ") : "none"}`
  );
  return NextResponse.json({ map: parsed.value, hasProvider: true });
});
