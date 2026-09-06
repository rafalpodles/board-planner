import { NextResponse } from "next/server";
import { connectDB } from "@/lib/db";
import { withAuth } from "@/lib/middleware";
import { accessibleProjectIds } from "@/lib/grants";
import { Notification } from "@/models/notification";

export const GET = withAuth(async (_request, { user }) => {
  await connectDB();

  const projectIds = await accessibleProjectIds(user);
  if (projectIds !== null && projectIds.length === 0) return NextResponse.json({ count: 0 });

  const filter: Record<string, unknown> = {
    recipient: user._id,
    read: false,
    inApp: { $ne: false },
  };
  if (projectIds !== null) filter.project = { $in: projectIds };

  const count = await Notification.countDocuments(filter);

  return NextResponse.json({ count });
});
