import { NextResponse } from "next/server";
import { isValidObjectId } from "mongoose";
import { connectDB } from "@/lib/db";
import { entitlementRefusal, withProjectAccess } from "@/lib/middleware";
import { readJsonBody } from "@/lib/request-body";
import { applyOne, type TriageAction } from "@/ee/ai/triage";

const ACTIONS: TriageAction[] = ["apply", "dismiss", "undo"];

export const GET = withProjectAccess(async (_request, { params, db }) => {
  const { projectId, taskId } = await params;
  await connectDB();
  const task = await db.Task.findOne({ _id: taskId, project: projectId }, "triage").lean();
  if (!task) return NextResponse.json({ error: "Task not found" }, { status: 404 });
  return NextResponse.json({ triage: task.triage ?? null });
});

// Dismissing stays open after a downgrade, so suggestions already shown can be cleared away
export const POST = withProjectAccess(async (request, { params, user, db }) => {
  const { projectId, taskId } = await params;
  const read = await readJsonBody(request);
  if (!read.ok) return read.response;
  const { suggestionId, action } = (read.value ?? {}) as { suggestionId?: unknown; action?: unknown };
  if (typeof suggestionId !== "string" || !isValidObjectId(suggestionId) || !ACTIONS.includes(action as TriageAction)) {
    return NextResponse.json({ error: "Name a suggestion and one of apply, dismiss or undo" }, { status: 400 });
  }
  if (action !== "dismiss") {
    const refusal = await entitlementRefusal(db, "ai.triage");
    if (refusal) return refusal;
  }
  await connectDB();
  if (!(await db.Task.exists({ _id: taskId, project: projectId }))) {
    return NextResponse.json({ error: "Task not found" }, { status: 404 });
  }
  const result = await applyOne(db, taskId, suggestionId, String(user._id), action as TriageAction);
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
  const task = await db.Task.findById(taskId, "triage").lean();
  return NextResponse.json({ triage: task?.triage ?? null });
});
