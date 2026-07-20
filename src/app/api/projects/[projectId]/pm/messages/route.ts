import { NextResponse } from "next/server";
import { isValidObjectId } from "mongoose";
import { connectDB } from "@/lib/db";
import { withProjectAccess } from "@/lib/middleware";
import { PmMessage } from "@/models/pmMessage";

export const GET = withProjectAccess(async (request, { params }) => {
  const { projectId } = await params;
  await connectDB();

  const url = new URL(request.url);
  const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 50, 1), 100);
  const before = url.searchParams.get("before");

  const filter: Record<string, unknown> = { project: projectId };
  if (before) {
    if (!isValidObjectId(before)) {
      return NextResponse.json({ error: "Invalid before cursor" }, { status: 400 });
    }
    filter._id = { $lt: before };
  }

  const messages = await PmMessage.find(filter)
    .sort({ _id: -1 })
    .limit(limit)
    .populate("triggeredBy", "username fullName");

  // Ascending for rendering; cursor for the next page is the first (oldest) _id
  messages.reverse();

  return NextResponse.json({
    messages,
    nextCursor: messages.length === limit ? String(messages[0]._id) : null,
  });
});
