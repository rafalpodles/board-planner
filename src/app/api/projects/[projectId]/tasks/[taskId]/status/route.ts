import { NextResponse } from "next/server";
import { connectDB } from "@/lib/db";
import { withProjectAccessOrWorker } from "@/lib/middleware";
import { changeStatus } from "@/lib/task-service";

export const PATCH = withProjectAccessOrWorker(async (request, { params, user }) => {
  const { projectId, taskId } = await params;
  await connectDB();

  const { status } = await request.json();

  const result = await changeStatus(projectId, taskId, status, String(user._id));
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status });
  }

  return NextResponse.json(result.data);
});
