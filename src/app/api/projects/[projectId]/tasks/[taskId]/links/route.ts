import { NextResponse } from "next/server";
import { isValidObjectId } from "mongoose";
import { connectDB } from "@/lib/db";
import { withProjectAccess } from "@/lib/middleware";
import { addTaskLink, removeTaskLink } from "@/lib/task-links";
import { DEPENDENCY_TYPES, DependencyType } from "@/types";

interface ParsedBody {
  targetTaskId: string;
  type: DependencyType;
}

async function parse(request: Request): Promise<ParsedBody | NextResponse> {
  const body = await request.json();
  // blockedByTaskId is the pre-CP-143 field name, still accepted
  const targetTaskId: unknown = body.taskId || body.blockedByTaskId;
  const type: DependencyType = body.type || "blocked_by";

  if (typeof targetTaskId !== "string" || !isValidObjectId(targetTaskId)) {
    return NextResponse.json({ error: "taskId is required" }, { status: 400 });
  }
  if (!DEPENDENCY_TYPES.includes(type)) {
    return NextResponse.json(
      { error: `type must be one of: ${DEPENDENCY_TYPES.join(", ")}` },
      { status: 400 }
    );
  }
  return { targetTaskId, type };
}

// Add a dependency. "blocked_by" lands in blockedBy (the relation that drives
// cycle detection); the rest go into the typed relations array.
export const POST = withProjectAccess(async (request, { params, user }) => {
  const { projectId, taskId } = await params;
  await connectDB();

  const parsed = await parse(request);
  if (parsed instanceof NextResponse) return parsed;

  const result = await addTaskLink(
    projectId,
    taskId,
    parsed.targetTaskId,
    parsed.type,
    String(user._id)
  );
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });

  return NextResponse.json({ message: "Dependency added" });
});

// Remove a dependency of any kind
export const DELETE = withProjectAccess(async (request, { params, user }) => {
  const { projectId, taskId } = await params;
  await connectDB();

  const parsed = await parse(request);
  if (parsed instanceof NextResponse) return parsed;

  const result = await removeTaskLink(
    projectId,
    taskId,
    parsed.targetTaskId,
    parsed.type,
    String(user._id)
  );
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });

  return NextResponse.json({ message: "Dependency removed" });
});
