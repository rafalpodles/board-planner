import { NextResponse } from "next/server";
import { connectDB } from "@/lib/db";
import { withAuth } from "@/lib/middleware";
import { machineCondition } from "@/lib/worker-service";
import type { ApiMyMachine, IWorker } from "@/types";

// The reader's own machines and nobody else's: whoever enrols a machine owns it (BP-358), and the
// fleet console that lists every machine is an instance admin's. Like the per-machine project picker
// this answers only a person at a browser, never a machine credential.
export const GET = withAuth(async (_request, { user, db }) => {
  if (user.viaMachineCredential) {
    return NextResponse.json({ error: "Interactive session required" }, { status: 403 });
  }
  await connectDB();

  const workers = await db.Worker.find(
    { owner: user._id },
    "_id name host version enabled lastSeenAt repos preflight command commandIssuedAt commandAckedAt halt"
  )
    .sort({ createdAt: 1 })
    .lean();

  const now = new Date();
  const machines: ApiMyMachine[] = workers.map((worker) => {
    const condition = machineCondition(worker as IWorker, now);
    return {
      _id: String(worker._id),
      name: worker.name,
      host: worker.host ?? "",
      version: worker.version ?? "",
      lastSeenAt: worker.lastSeenAt ? new Date(worker.lastSeenAt).toISOString() : null,
      state: condition.state,
      haltedBy: condition.haltedBy,
      checkouts: (worker.repos ?? []).length,
    };
  });
  return NextResponse.json(machines);
});
