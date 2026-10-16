import { NextResponse } from "next/server";
import { isValidObjectId } from "mongoose";
import { connectDB } from "@/lib/db";
import { requireEntitlement, withProjectAccess } from "@/lib/middleware";
import { readJsonBody } from "@/lib/request-body";
import { countAttempt, sourceKey } from "@/lib/rate-limit";
import { TASK_DESCRIPTION_MAX_LENGTH, TASK_TITLE_MAX_LENGTH } from "@/lib/identifiers";
import { findDuplicates } from "@/ee/ai/duplicates";

export const CHECKS_PER_USER_WINDOW = 30;
const inFlight = new Set<string>();

export const POST = withProjectAccess(
  requireEntitlement("ai.duplicates", async (request, { params, user, db }) => {
    const { projectId } = await params;
    const read = await readJsonBody<{ title?: unknown; description?: unknown; taskId?: unknown }>(request);
    if (!read.ok) return read.response;
    const { title, description = "", taskId } = read.value;
    if (typeof title !== "string" || !title.trim() || title.length > TASK_TITLE_MAX_LENGTH) {
      return NextResponse.json({ error: "A title is needed to look for duplicates" }, { status: 400 });
    }
    if (typeof description !== "string" || description.length > TASK_DESCRIPTION_MAX_LENGTH) {
      return NextResponse.json({ error: "description must be text" }, { status: 400 });
    }
    if (taskId !== undefined && (typeof taskId !== "string" || !isValidObjectId(taskId))) {
      return NextResponse.json({ error: "taskId must be a task id" }, { status: 400 });
    }

    const holder = String(user._id);
    if ((await countAttempt(sourceKey(`user:${holder}`, "ai-duplicates"))) > CHECKS_PER_USER_WINDOW) {
      return NextResponse.json({ error: "Too many duplicate checks. Try again in 15 minutes." }, { status: 429 });
    }
    if (inFlight.has(holder)) return NextResponse.json({ error: "A duplicate check is already running." }, { status: 409 });
    inFlight.add(holder);
    try {
      await connectDB();
      if (taskId && !(await db.Task.exists({ _id: taskId, project: projectId }))) {
        return NextResponse.json({ error: "Task not found" }, { status: 404 });
      }
      const result = await findDuplicates(db, { projectId, userId: holder }, { title: title.trim(), description }, taskId as string | undefined);
      if (!result.ok) return NextResponse.json(result.body, { status: result.status });
      return NextResponse.json({ duplicates: result.duplicates, shortlisted: result.shortlisted });
    } finally {
      inFlight.delete(holder);
    }
  })
);
