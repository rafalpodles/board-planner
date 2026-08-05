import { NextResponse } from "next/server";
import { isValidObjectId } from "mongoose";
import { connectDB } from "@/lib/db";
import { withProjectAccess } from "@/lib/middleware";
import { Task } from "@/models/task";
import { manualOrder, placeInto } from "@/lib/reorder";

const MAX_IDS = 1000;

/**
 * Reorders tasks by rewriting `order` across the whole project.
 *
 * The client only ever sends the rows it can see — a filter or a sprint scope means
 * that is a subset — so the received sequence is placed into the positions those
 * tasks already occupied among all of them. Anything filtered out keeps its place
 * relative to the rest, and renumbering everything clears the ties left by the
 * schema default of 0, which is what made a drag look like it did nothing.
 */
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
  // Checked before it reaches Mongoose: a malformed id there is a CastError, which
  // would surface as a 500 rather than the 400 this is
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
  // Scoped to the project, so ids from another board cannot be reordered through it
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

  // timestamps off: a reorder touches many tasks, and letting the schema stamp
  // updatedAt would reset the whole list to "just now" on each drag
  if (writes.length) await Task.bulkWrite(writes, { timestamps: false });

  return NextResponse.json({ updated: writes.length });
});
