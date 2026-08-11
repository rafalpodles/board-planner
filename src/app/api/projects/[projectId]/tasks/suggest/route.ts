import { NextResponse } from "next/server";
import { connectDB } from "@/lib/db";
import { withProjectAccess } from "@/lib/middleware";
import { Task } from "@/models/task";

const LIMIT = 10;

/**
 * What the editor offers after somebody types the project key. Separate from /api/search, which
 * resolves an exact key or searches text across every accessible project — here the project is
 * already known and a partial number has to match by prefix: `1` means BP-1 as well as BP-10..19.
 */
export const GET = withProjectAccess(async (request, { params }) => {
  const { projectId } = await params;
  await connectDB();

  const q = (new URL(request.url).searchParams.get("q") ?? "").trim().slice(0, 40);
  const filter: Record<string, unknown> = { project: projectId };

  if (/^\d+$/.test(q)) {
    // By prefix, on the number as written. Expressed as a regex over the stringified number rather
    // than as numeric ranges, which for "1" would be [1,2) plus [10,20) plus [100,200) and so on.
    filter.$expr = {
      $regexMatch: { input: { $toString: "$taskNumber" }, regex: `^${q}` },
    };
  } else if (q) {
    filter.title = { $regex: q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), $options: "i" };
  }

  const tasks = await Task.find(filter, "taskNumber title status")
    // Digits sort by number so BP-1 precedes BP-10; anything else is a text search, where the most
    // recently touched task is the likelier one to be referring to
    .sort(/^\d+$/.test(q) ? { taskNumber: 1 } : { updatedAt: -1 })
    .limit(LIMIT)
    .lean();

  return NextResponse.json(tasks);
});
