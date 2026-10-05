import { NextResponse } from "next/server";
import { isValidObjectId, Types } from "mongoose";
import { connectDB } from "@/lib/db";
import { withProjectAccess } from "@/lib/middleware";
import { logActivity } from "@/lib/activity";
import { MAX_CHECKLIST_ITEMS } from "@/lib/identifiers";
import { criterionTextOrRefusal } from "@/lib/checklist-item";

// Adds one acceptance criterion to the end of the list, in one update. The whole-list write the task
// form uses reads the list first, so a tick landing in between is overwritten; this does not read it.
export const POST = withProjectAccess(async (request, { params, user, db }) => {
  const { projectId, taskId } = await params;
  if (!isValidObjectId(taskId)) return NextResponse.json({ error: "Invalid task id" }, { status: 400 });
  await connectDB();

  const body = (await request.json().catch(() => null)) as { text?: unknown; done?: unknown } | null;
  const text = criterionTextOrRefusal(body?.text);
  if ("error" in text) return NextResponse.json({ error: text.error }, { status: 400 });
  if (body?.done !== undefined && typeof body.done !== "boolean") {
    return NextResponse.json({ error: "A criterion is either done or it is not" }, { status: 400 });
  }

  const item = { _id: new Types.ObjectId(), text: text.text, done: body?.done === true };
  const updated = await db.Task.findOneAndUpdate(
    // The count is part of the match, so two adds racing cannot both slip past the cap
    { _id: taskId, project: projectId, [`checklist.${MAX_CHECKLIST_ITEMS - 1}`]: { $exists: false } },
    { $push: { checklist: item } },
    { returnDocument: "after" }
  );
  if (!updated) {
    return (await db.Task.exists({ _id: taskId, project: projectId }))
      ? NextResponse.json({ error: `A task can have at most ${MAX_CHECKLIST_ITEMS} acceptance criteria` }, { status: 400 })
      : NextResponse.json({ error: "Task not found" }, { status: 404 });
  }

  await logActivity(db, taskId, user._id, "criterion_added", String(item._id), "", item.text);
  return NextResponse.json({ item, checklist: updated.checklist }, { status: 201 });
});
