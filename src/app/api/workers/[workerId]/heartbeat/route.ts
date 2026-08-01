import { NextResponse } from "next/server";
import { withWorker, protocolOf } from "@/lib/middleware";
import { touchWorker } from "@/lib/worker-service";

// The only path guaranteed to survive SSE loss, so it carries both the abort
// verdict and the command acknowledgement
export const POST = withWorker(async (request, { worker }) => {
  const body = await request.json().catch(() => ({}));

  if (!worker.enabled || worker.lockedByInstance) {
    return NextResponse.json({ error: "this worker may not run", abort: true }, { status: 403 });
  }

  const protocolVersion = protocolOf(request);
  await touchWorker(String(worker._id), {
    // A missing/unparseable protocol header must not overwrite a valid stored version with NaN
    ...(Number.isFinite(protocolVersion) ? { protocolVersion } : {}),
    version: typeof body.version === "string" ? body.version : worker.version,
    // An ack for a command that is no longer current must not clear the newer one
    ...(body.acked && body.acked === worker.command ? { commandAckedAt: new Date() } : {}),
    ...(typeof body.bindingError === "string" ? { bindingError: body.bindingError } : {}),
  });

  return NextResponse.json({
    command: worker.command,
    policy: worker.policy,
    assignments: worker.assignments.map((a) => ({
      project: String(a.project),
      proposedPath: a.proposedPath,
    })),
  });
});
