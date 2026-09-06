import { NextResponse } from "next/server";
import { connectDB } from "@/lib/db";
import { withProjectAccess } from "@/lib/middleware";
import { Task } from "@/models/task";

const LIMIT = 10;

export const GET = withProjectAccess(async (request, { params }) => {
  const { projectId } = await params;
  await connectDB();

  const q = (new URL(request.url).searchParams.get("q") ?? "").trim().slice(0, 40);
  const filter: Record<string, unknown> = { project: projectId };

  if (/^\d+$/.test(q)) {
    filter.$expr = {
      $regexMatch: { input: { $toString: "$taskNumber" }, regex: `^${q}` },
    };
  } else if (q) {
    filter.title = { $regex: q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), $options: "i" };
  }

  const tasks = await Task.find(filter, "taskNumber title status")
    .sort(/^\d+$/.test(q) ? { taskNumber: 1 } : { updatedAt: -1 })
    .limit(LIMIT)
    .lean();

  return NextResponse.json(tasks);
});
