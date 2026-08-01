import { NextResponse } from "next/server";
import { connectDB } from "@/lib/db";
import { withAdmin, protocolOf } from "@/lib/middleware";
import { registerWorker, PROTOCOL_VERSION, WORKER_HEARTBEAT_MS } from "@/lib/worker-service";

// Deliberately withAdmin, not withAuth: minting a worker credential is an
// instance-level act, not something a project-scoped token can do
export const POST = withAdmin(async (request) => {
  await connectDB();
  const body = await request.json().catch(() => ({}));
  const name = typeof body.name === "string" ? body.name.trim() : "";
  const host = typeof body.host === "string" ? body.host.trim() : "";
  if (!name || !host) {
    return NextResponse.json({ error: "name and host are required" }, { status: 400 });
  }
  if (protocolOf(request) !== PROTOCOL_VERSION) {
    return NextResponse.json(
      { error: `server speaks protocol ${PROTOCOL_VERSION}` },
      { status: 409 }
    );
  }

  const { worker, credential } = await registerWorker({
    name,
    host,
    platform: String(body.platform ?? ""),
    version: String(body.version ?? ""),
  });

  return NextResponse.json({
    workerId: String(worker._id),
    credential,
    heartbeatMs: WORKER_HEARTBEAT_MS,
    policy: worker.policy,
    assignments: worker.assignments.map((a) => ({
      project: String(a.project),
      proposedPath: a.proposedPath,
    })),
  });
});
