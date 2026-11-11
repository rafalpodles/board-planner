import { NextResponse } from "next/server";
import { isValidObjectId } from "mongoose";
import { withProjectAccess } from "@/lib/middleware";
import { acceptHandover } from "@/lib/task-service";
import { withApiExecution } from "@/lib/task-execution-view";

export const ACCEPT_NEEDS_A_PERSON = "accepting a hand-over needs an interactive session";

export const POST = withProjectAccess(async (_request, { params, user, db }) => {
  const { projectId, taskId } = await params;
  if (!isValidObjectId(taskId)) {
    return NextResponse.json({ error: "Invalid task id" }, { status: 400 });
  }

  // The consent this records lets a machine run somebody else's text with its owner's rights, so
  // this door is a person's. Not a wall on its own: a machine credential can still put a task in
  // its own hands through the task PUT, which BP-1149 decides about
  if (user.viaMachineCredential) {
    return NextResponse.json({ error: ACCEPT_NEEDS_A_PERSON }, { status: 403 });
  }

  const result = await acceptHandover(db, projectId, taskId, String(user._id));
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status });
  }
  return NextResponse.json(await withApiExecution(db, result.data));
});
