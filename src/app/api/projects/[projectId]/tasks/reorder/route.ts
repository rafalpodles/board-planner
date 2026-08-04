import { NextResponse } from "next/server";
import { connectDB } from "@/lib/db";
import { withProjectAccess } from "@/lib/middleware";
import { Task } from "@/models/task";

// Reindexes rather than nudging a single task: order defaults to 0, so on a board
// nobody has dragged yet every task ties and there is no gap to insert into.
export const PUT = withProjectAccess(async (request, { params }) => {
  const { projectId } = await params;
  await connectDB();

  const body = await request.json();
  const ids: unknown = body?.order;

  if (!Array.isArray(ids) || ids.some((id) => typeof id !== "string")) {
    return NextResponse.json(
      { error: "order must be an array of task ids" },
      { status: 400 }
    );
  }

  const unique = new Set(ids as string[]);
  if (unique.size !== ids.length) {
    return NextResponse.json({ error: "order contains duplicate ids" }, { status: 400 });
  }

  // Scoped to the project, so ids from another board cannot be reordered through it
  const known = await Task.find({ _id: { $in: ids }, project: projectId })
    .select("_id")
    .lean();
  if (known.length !== ids.length) {
    return NextResponse.json(
      { error: "order contains unknown task ids" },
      { status: 400 }
    );
  }

  await Task.bulkWrite(
    (ids as string[]).map((id, index) => ({
      updateOne: { filter: { _id: id }, update: { $set: { order: index } } },
    }))
  );

  return NextResponse.json({ updated: ids.length });
});
