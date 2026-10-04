import { NextResponse } from "next/server";
import { isValidObjectId } from "mongoose";
import { connectDB } from "@/lib/db";
import { withProjectAccess } from "@/lib/middleware";
import { pmThreadFilter } from "@/lib/pm/thread";
import { finalizeAbandonedTurns } from "@/lib/pm/abandoned";

export const GET = withProjectAccess(async (request, { params, user, db }) => {
  const { projectId } = await params;
  await connectDB();

  const url = new URL(request.url);
  const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 50, 1), 100);
  const before = url.searchParams.get("before");

  // Conversations are private; an instance admin may read another user's for support
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

  const newestFirst = await db.PmMessage.find(filter)
    .sort({ _id: -1 })
    .limit(limit + 1)
    .populate("triggeredBy", "username fullName");
  const hasOlder = newestFirst.length > limit;

  // Ascending for rendering; cursor for the next page is the first (oldest) _id
  const messages = newestFirst.slice(0, limit).reverse();

  return NextResponse.json({
    messages,
    nextCursor: hasOlder ? String(messages[0]._id) : null,
  });
});
