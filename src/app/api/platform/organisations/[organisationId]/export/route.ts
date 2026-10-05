import { scoped } from "@/lib/db-scope";
import { logInstanceAudit } from "@/lib/instanceAudit";
import { organisationExportResponse } from "@/lib/organisation-export-response";
import { organisationForLifeCycle } from "@/lib/organisation-life-cycle";
import { lifeCycleRefused } from "@/lib/platform-life-cycle-route";
import { logPlatformAudit, withPlatformRequest } from "@/lib/platform-route";

// The operator's copy, for an organisation that can no longer sign in to take its own: suspended, before a delete
export const GET = withPlatformRequest<{ organisationId: string }>(async (_request, { keyId, params }) => {
  const found = await organisationForLifeCycle(params.organisationId);
  if (!found.ok) return lifeCycleRefused(found.reason);
  const { row } = found;
  const db = scoped(row._id);
  // In the organisation's own log as well: its admins can see the operator took a copy
  return organisationExportResponse(db, row.slug ?? "organisation", async () => {
    await logPlatformAudit({ action: "organisation_exported", keyId, subject: row._id }, { strict: true });
    await logInstanceAudit(db, { action: "organisation_exported", actorUsername: "Board Planner", target: row.slug ?? "", detail: "exported by the service operator" }, { strict: true });
  });
}, { maxBodyBytes: 0 });
