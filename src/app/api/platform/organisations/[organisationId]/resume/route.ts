import { NextResponse } from "next/server";
import { organisationForLifeCycle, setSuspended } from "@/lib/organisation-life-cycle";
import { Organisation } from "@/models/organisation";
import { lifeCycleRefused } from "@/lib/platform-life-cycle-route";
import { logPlatformAudit, withPlatformRequest } from "@/lib/platform-route";

export const POST = withPlatformRequest<{ organisationId: string }>(async (_request, { keyId, params }) => {
  const found = await organisationForLifeCycle(params.organisationId);
  if (!found.ok) return lifeCycleRefused(found.reason);
  if (!(await setSuspended(found.row._id, false))) {
    return NextResponse.json({ error: "The organisation is being deleted" }, { status: 409 });
  }
  // An operator who brings an organisation back means it: whatever the dead-organisation sweep told it is void
  await Organisation.updateOne({ _id: found.row._id }, { $set: { deadNoticeAt: null, deadReminderAt: null } });
  await logPlatformAudit({ action: "organisation_resumed", keyId, subject: found.row._id });
  return NextResponse.json({ suspended: false });
}, { maxBodyBytes: 0 });
