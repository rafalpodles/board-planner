import { NextResponse } from "next/server";
import { isValidObjectId } from "mongoose";
import { connectDB } from "@/lib/db";
import { withAdmin } from "@/lib/middleware";
import { Worker } from "@/models/worker";
import { publishToWorker } from "@/lib/worker-events";
import { logInstanceAudit } from "@/lib/instanceAudit";

const COMMANDS = ["pause", "resume", "stop"] as const;

// Issuing a command is its own endpoint, not a PATCH field: it clears
// commandAckedAt so the console can tell "asked to pause" from "actually paused",
// which a field-by-field edit on /api/workers/:workerId must not be able to do
export const POST = withAdmin(async (request, { params, user }) => {
  // A machine credential must not reach a kill switch. An unscoped admin API token keeps
  // role: "admin" and so passes withAdmin; the counterpart to this action is already gated
  // this way, and the asymmetry was the bug (BP-306).
  if (user.viaMachineCredential) {
    return NextResponse.json({ error: "Interactive admin session required" }, { status: 403 });
  }

  await connectDB();

  const { workerId } = await params;
  if (!isValidObjectId(workerId)) {
    return NextResponse.json({ error: "Worker not found" }, { status: 404 });
  }

  const body = (await request.json().catch(() => ({}))) ?? {};
  const command = (body as Record<string, unknown>).command;
  if (typeof command !== "string" || !COMMANDS.includes(command as (typeof COMMANDS)[number])) {
    return NextResponse.json({ error: "command must be pause, resume or stop" }, { status: 400 });
  }

  const worker = await Worker.findByIdAndUpdate(
    workerId,
    { $set: { command, commandIssuedAt: new Date(), commandAckedAt: null } },
    { new: true }
  );
  if (!worker) {
    return NextResponse.json({ error: "Worker not found" }, { status: 404 });
  }

  // The other way to stop a machine. Recording only lockedByInstance would leave an operator
  // reading a log full of worker_locked rows and concluding nothing else had stopped anything.
  void logInstanceAudit({
    action: "worker_command_sent",
    target: worker.name,
    user: String(user._id),
    actorUsername: user.username,
    detail: command,
  });

  // Best-effort accelerator — see src/lib/worker-events.ts; the write above is what's durable.
  // commandIssuedAt rides along so a worker that sees the same issuance twice, once here and once
  // on its next heartbeat, can tell it apart from the operator asking again.
  publishToWorker(String(worker._id), {
    command: worker.command,
    ...(worker.commandIssuedAt ? { commandIssuedAt: new Date(worker.commandIssuedAt).toISOString() } : {}),
  });

  return NextResponse.json({ command: worker.command, issuedAt: worker.commandIssuedAt });
});
