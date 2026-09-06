import { NextResponse } from "next/server";
import { isValidObjectId } from "mongoose";
import { connectDB } from "@/lib/db";
import { withProjectAccess } from "@/lib/middleware";
import { PmMessage } from "@/models/pmMessage";
import { pmThreadFilter } from "@/lib/pm/thread";
import { finalizeAbandonedTurns } from "@/lib/pm/abandoned";

export const GET = withProjectAccess(async (request, { params, user }) => {
  const { projectId } = await params;
  await connectDB();

  const url = new URL(request.url);
  const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 50, 1), 100);
  const before = url.searchParams.get("before");

  const requestedUserId = url.searchParams.get("userId");
  let threadUserId = String(user._id);
  if (requestedUserId && requestedUserId !== threadUserId) {
    if (user.role !== "admin") {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    if (!isValidObjectId(requestedUserId)) {
      return NextResponse.json({ error: "Invalid userId" }, { status: 400 });
    }
    threadUserId = requestedUserId;
  }

  await finalizeAbandonedTurns(projectId, threadUserId);

  const filter: Record<string, unknown> = pmThreadFilter(projectId, threadUserId);
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

  messages.reverse();

  return NextResponse.json({
    messages,
    nextCursor: messages.length === limit ? String(messages[0]._id) : null,
  });
});
