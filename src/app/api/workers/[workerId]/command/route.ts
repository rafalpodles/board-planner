import { NextResponse } from "next/server";
import { isValidObjectId } from "mongoose";
import { connectDB } from "@/lib/db";
import { withAdmin } from "@/lib/middleware";
import { Worker } from "@/models/worker";
import { publishToWorker } from "@/lib/worker-events";
import { logInstanceAudit } from "@/lib/instanceAudit";

const COMMANDS = ["pause", "resume", "stop"] as const;

export const POST = withAdmin(async (request, { params, user }) => {
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

  void logInstanceAudit({
    action: "worker_command_sent",
    target: worker.name,
    user: String(user._id),
    actorUsername: user.username,
    detail: command,
  });

  publishToWorker(String(worker._id), {
    command: worker.command,
    ...(worker.commandIssuedAt ? { commandIssuedAt: new Date(worker.commandIssuedAt).toISOString() } : {}),
  });

  return NextResponse.json({ command: worker.command, issuedAt: worker.commandIssuedAt });
});
