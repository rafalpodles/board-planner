import { NextResponse } from "next/server";
import { connectDB } from "@/lib/db";
import { withAuth } from "@/lib/middleware";
import { Notification } from "@/models/notification";

export const GET = withAuth(async (request, { user }) => {
  await connectDB();

  const url = new URL(request.url);
  const limit = Math.min(parseInt(url.searchParams.get("limit") || "30"), 100);
  const before = url.searchParams.get("before"); // cursor pagination

  const filter: Record<string, unknown> = { recipient: user._id };
  if (before) {
    filter.createdAt = { $lt: new Date(before) };
  }

  const notifications = await Notification.find(filter)
    .sort({ createdAt: -1 })
    .limit(limit)
    .populate("actor", "username fullName")
    .populate("task", "taskNumber title")
    .populate("project", "key name");

  return NextResponse.json(notifications);
});
