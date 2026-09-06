import { NextResponse } from "next/server";
import { isValidObjectId } from "mongoose";
import { connectDB } from "@/lib/db";
import { withProjectAccess } from "@/lib/middleware";
import { Task } from "@/models/task";
import { manualOrder, placeInto } from "@/lib/reorder";

const MAX_IDS = 1000;

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
  if (ids.length > MAX_IDS) {
    return NextResponse.json({ error: `order accepts at most ${MAX_IDS} ids` }, { status: 400 });
  }
  if ((ids as string[]).some((id) => !isValidObjectId(id))) {
    return NextResponse.json({ error: "order contains a malformed task id" }, { status: 400 });
  }

  const unique = new Set(ids as string[]);
  if (unique.size !== ids.length) {
    return NextResponse.json({ error: "order contains duplicate ids" }, { status: 400 });
  }

  const all = await Task.find({ project: projectId })
    .select("_id order createdAt taskNumber")
    .lean();

  const known = new Set(all.map((t) => String(t._id)));
  if ((ids as string[]).some((id) => !known.has(id))) {
    return NextResponse.json({ error: "order contains unknown task ids" }, { status: 400 });
  }

  const sorted = manualOrder(
    all.map((t) => ({
      id: String(t._id),
      order: t.order ?? 0,
      createdAt: new Date(t.createdAt).getTime(),
      taskNumber: t.taskNumber,
    }))
  );
  const next = placeInto(sorted, ids as string[]);

  const writes = next
    .map((id, index) => ({ id, index }))
    .filter(({ id, index }) => {
      const current = all.find((t) => String(t._id) === id);
      return (current?.order ?? 0) !== index;
    })
    .map(({ id, index }) => ({
      updateOne: { filter: { _id: id, project: projectId }, update: { $set: { order: index } } },
    }));

  if (writes.length) await Task.bulkWrite(writes, { timestamps: false });

  return NextResponse.json({ updated: writes.length });
});
