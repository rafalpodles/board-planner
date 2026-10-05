import { scoped } from "@/lib/db-scope";
import { organisationExportResponse } from "@/lib/organisation-export-response";
import { organisationForLifeCycle } from "@/lib/organisation-life-cycle";
import { lifeCycleRefused } from "@/lib/platform-life-cycle-route";
import { logPlatformAudit, withPlatformRequest } from "@/lib/platform-route";

// The operator's copy, for an organisation that can no longer sign in to take its own: suspended, before a delete
export const GET = withPlatformRequest<{ organisationId: string }>(async (_request, { keyId, params }) => {
  const found = await organisationForLifeCycle(params.organisationId);
  if (!found.ok) return lifeCycleRefused(found.reason);
  const { row } = found;
  return organisationExportResponse(scoped(row._id), row.slug ?? "organisation", () =>
    logPlatformAudit({ action: "organisation_exported", keyId, subject: row._id })
  );
}, { maxBodyBytes: 0 });
