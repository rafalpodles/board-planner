import { requireEntitlement, withProjectOwner } from "@/lib/middleware";
import { syncProjectToCoda } from "@/ee/connectors/coda/sync";

export const POST = withProjectOwner(
  requireEntitlement("integrations.coda", async (_request, { params }) => syncProjectToCoda((await params).projectId))
);
