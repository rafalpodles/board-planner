import { NextResponse } from "next/server";
import { connectDB } from "@/lib/db";
import { withProjectAccess } from "@/lib/middleware";
import { Task } from "@/models/task";

// Add a checklist item
export const POST = withProjectAccess(async (request, { params }) => {
  const { projectId, taskId } = await params;
  await connectDB();

  const { text } = await request.json();
  if (!text || typeof text !== "string" || !text.trim()) {
    return NextResponse.json({ error: "Text is required" }, { status: 400 });
  }

  const task = await Task.findOneAndUpdate(
    { _id: taskId, project: projectId },
    { $push: { checklist: { text: text.trim(), done: false } } },
    { new: true }
  );

  if (!task) {
    return NextResponse.json({ error: "Task not found" }, { status: 404 });
  }

  return NextResponse.json(task.checklist);
});

// Update a checklist item (toggle done, edit text, reorder)
export const PUT = withProjectAccess(async (request, { params }) => {
  const { projectId, taskId } = await params;
  await connectDB();

  const { itemId, done, text, checklist: newOrder } = await request.json();

  // Full reorder — replace entire checklist array
  if (Array.isArray(newOrder)) {
    // Validate each item has the expected shape
    const valid = newOrder.every(
      (item: unknown) =>
        typeof item === "object" && item !== null &&
        typeof (item as Record<string, unknown>).text === "string" &&
        typeof (item as Record<string, unknown>).done === "boolean"
    );
    if (!valid) {
      return NextResponse.json(
        { error: "Each checklist item must have text (string) and done (boolean)" },
        { status: 400 }
      );
    }
    const sanitized = newOrder.map((item: { text: string; done: boolean; _id?: string }) => ({
      text: item.text,
      done: item.done,
      ...(item._id ? { _id: item._id } : {}),
    }));
    const task = await Task.findOneAndUpdate(
      { _id: taskId, project: projectId },
      { $set: { checklist: sanitized } },
      { new: true }
    );
    if (!task) {
      return NextResponse.json({ error: "Task not found" }, { status: 404 });
    }
    return NextResponse.json(task.checklist);
  }

  if (!itemId) {
    return NextResponse.json({ error: "itemId is required" }, { status: 400 });
  }

  const task = await Task.findOne({ _id: taskId, project: projectId });
  if (!task) {
    return NextResponse.json({ error: "Task not found" }, { status: 404 });
  }

  const item = task.checklist.find((i) => i._id.toString() === itemId);
  if (!item) {
    return NextResponse.json({ error: "Item not found" }, { status: 404 });
  }

  if (done !== undefined) item.done = done;
  if (text !== undefined) item.text = text;

  await task.save();
  return NextResponse.json(task.checklist);
});

// Remove a checklist item
export const DELETE = withProjectAccess(async (request, { params }) => {
  const { projectId, taskId } = await params;
  await connectDB();

  const { itemId } = await request.json();
  if (!itemId) {
    return NextResponse.json({ error: "itemId is required" }, { status: 400 });
  }

  const task = await Task.findOneAndUpdate(
    { _id: taskId, project: projectId },
    { $pull: { checklist: { _id: itemId } } },
    { new: true }
  );

  if (!task) {
    return NextResponse.json({ error: "Task not found" }, { status: 404 });
  }

  return NextResponse.json(task.checklist);
});
