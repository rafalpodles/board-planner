import { NextResponse } from "next/server";
import { connectDB } from "@/lib/db";
import { withAuth } from "@/lib/middleware";
import { accessibleProjectIds } from "@/lib/grants";
import { Notification } from "@/models/notification";

export const GET = withAuth(async (request, { user }) => {
  await connectDB();

  const url = new URL(request.url);
  const limit = Math.min(parseInt(url.searchParams.get("limit") || "30"), 100);
  const before = url.searchParams.get("before"); // cursor pagination

  // Rows banked before a grant was revoked are still addressed to the reader, so keying the feed
  // on the recipient alone hands them back afterwards (BP-328). null means every project.
  const projectIds = await accessibleProjectIds(user);
  if (projectIds !== null && projectIds.length === 0) return NextResponse.json([]);

  // And rows the grid hid from the bell are still stored, because the digest is built from them.
  // `$ne: false` rather than `true`: everything written before BP-371 has no field at all.
  const filter: Record<string, unknown> = { recipient: user._id, inApp: { $ne: false } };
  if (projectIds !== null) filter.project = { $in: projectIds };
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
