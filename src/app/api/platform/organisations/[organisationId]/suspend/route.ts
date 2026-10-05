import { NextResponse } from "next/server";
import { organisationForLifeCycle, setSuspended } from "@/lib/organisation-life-cycle";
import { lifeCycleRefused } from "@/lib/platform-life-cycle-route";
import { logPlatformAudit, withPlatformRequest } from "@/lib/platform-route";

const MAX_REASON = 500;

export const POST = withPlatformRequest<{ organisationId: string }>(async (_request, { keyId, body, params }) => {
  let reason: unknown = "";
  if (body.length > 0) {
    try {
      reason = (JSON.parse(new TextDecoder().decode(body)) as { reason?: unknown })?.reason ?? "";
    } catch {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }
  }
  if (typeof reason !== "string" || reason.length > MAX_REASON) {
    return NextResponse.json({ error: `reason must be a string of at most ${MAX_REASON} characters` }, { status: 400 });
  }

  const found = await organisationForLifeCycle(params.organisationId);
  if (!found.ok) return lifeCycleRefused(found.reason);
  if (!(await setSuspended(found.row._id, true, reason))) {
    return NextResponse.json({ error: "The organisation is being deleted" }, { status: 409 });
  }
  await logPlatformAudit({ action: "organisation_suspended", keyId, subject: found.row._id, detail: reason });
  return NextResponse.json({ suspended: true });
});
