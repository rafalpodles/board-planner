import { NextResponse } from "next/server";
import { deleteOrganisationData, organisationFootprint, organisationForLifeCycle, settledSince, SUSPENSION_SETTLE_MS } from "@/lib/organisation-life-cycle";
import { lifeCycleRefused } from "@/lib/platform-life-cycle-route";
import { logPlatformAudit, withPlatformRequest } from "@/lib/platform-route";

export const DELETE = withPlatformRequest<{ organisationId: string }>(async (request, { keyId, params }) => {
  const query = new URL(request.url).searchParams;
  const found = await organisationForLifeCycle(params.organisationId);
  if (!found.ok) return lifeCycleRefused(found.reason);
  const { row } = found;

  if (query.get("dryRun") === "1") {
    return NextResponse.json({ dryRun: true, counts: await organisationFootprint(row._id) });
  }
  if (!row.suspendedAt) {
    return NextResponse.json({ error: "Suspend the organisation before deleting it" }, { status: 409 });
  }
  if (!settledSince(row.suspendedAt)) {
    const after = new Date(row.suspendedAt.getTime() + SUSPENSION_SETTLE_MS).toISOString();
    return NextResponse.json({ error: `Work admitted before the suspension may still be writing; delete after ${after}`, after }, { status: 409 });
  }
  if (!row.slug || query.get("confirm") !== row.slug) {
    return NextResponse.json({ error: "confirm must name the organisation's slug" }, { status: 400 });
  }

  const removed = await deleteOrganisationData(row._id);
  await logPlatformAudit({ action: "organisation_deleted", keyId, subject: row._id, detail: `${row.slug}: ${JSON.stringify(removed)}` });
  return NextResponse.json({ deleted: true, counts: removed });
}, { maxBodyBytes: 0 });
