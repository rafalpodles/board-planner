import { NextResponse } from "next/server";
import { isValidObjectId } from "mongoose";
import { connectDB } from "@/lib/db";
import { withProjectAccess } from "@/lib/middleware";
import { logActivity } from "@/lib/activity";
import { criterionTextOrRefusal } from "@/lib/checklist-item";

type Row = { _id: unknown; text: string; done?: boolean };

async function missing(db: Parameters<Parameters<typeof withProjectAccess>[0]>[1]["db"], projectId: string, taskId: string) {
  return (await db.Task.exists({ _id: taskId, project: projectId }))
    ? NextResponse.json({ error: "Criterion not found" }, { status: 404 })
    : NextResponse.json({ error: "Task not found" }, { status: 404 });
}

// One criterion, changed in place by its id. `returnDocument: "before"` hands back the row as it was, so
// the history records what this write changed rather than what it overwrote.
export const PATCH = withProjectAccess(async (request, { params, user, db }) => {
  const { projectId, taskId, itemId } = await params;
  if (!isValidObjectId(taskId) || !isValidObjectId(itemId)) {
    return NextResponse.json({ error: "Invalid id" }, { status: 400 });
  }
  await connectDB();

  const body = (await request.json().catch(() => null)) as { text?: unknown; done?: unknown } | null;
  const change: Record<string, unknown> = {};
  if (body?.text !== undefined) {
    const text = criterionTextOrRefusal(body.text);
    if ("error" in text) return NextResponse.json({ error: text.error }, { status: 400 });
    change["checklist.$[c].text"] = text.text;
  }
  if (body?.done !== undefined) {
    if (typeof body.done !== "boolean") {
      return NextResponse.json({ error: "A criterion is either done or it is not" }, { status: 400 });
    }
    change["checklist.$[c].done"] = body.done;
  }
  if (Object.keys(change).length === 0) {
    return NextResponse.json({ error: "Name text, done or both" }, { status: 400 });
  }

  const before = await db.Task.findOneAndUpdate(
    { _id: taskId, project: projectId, "checklist._id": itemId },
    { $set: change },
    { arrayFilters: [{ "c._id": itemId }], returnDocument: "before" }
  );
  if (!before) return missing(db, projectId, taskId);

  const rows = (before.checklist ?? []) as Row[];
  const old = rows.find((row) => String(row._id) === itemId)!;
  const next = { ...old, ...(change["checklist.$[c].text"] !== undefined ? { text: change["checklist.$[c].text"] as string } : {}), ...(change["checklist.$[c].done"] !== undefined ? { done: change["checklist.$[c].done"] as boolean } : {}) };
  if (next.text !== old.text) await logActivity(db, taskId, user._id, "criterion_edited", itemId, old.text, next.text);
  if (!!next.done !== !!old.done) {
    await logActivity(db, taskId, user._id, next.done ? "criterion_checked" : "criterion_unchecked", itemId, "", next.text);
  }

  const checklist = rows.map((row) => (String(row._id) === itemId ? { ...row, text: next.text, done: !!next.done } : row));
  return NextResponse.json({ checklist });
});

export const DELETE = withProjectAccess(async (_request, { params, user, db }) => {
  const { projectId, taskId, itemId } = await params;
  if (!isValidObjectId(taskId) || !isValidObjectId(itemId)) {
    return NextResponse.json({ error: "Invalid id" }, { status: 400 });
  }
  await connectDB();

  const before = await db.Task.findOneAndUpdate(
    { _id: taskId, project: projectId, "checklist._id": itemId },
    { $pull: { checklist: { _id: itemId } } },
    { returnDocument: "before" }
  );
  if (!before) return missing(db, projectId, taskId);

  const rows = (before.checklist ?? []) as Row[];
  const old = rows.find((row) => String(row._id) === itemId)!;
  await logActivity(db, taskId, user._id, "criterion_removed", itemId, old.text, "");
  return NextResponse.json({ checklist: rows.filter((row) => String(row._id) !== itemId) });
});
