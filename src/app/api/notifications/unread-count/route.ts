import { NextResponse } from "next/server";
import { connectDB } from "@/lib/db";
import { withAuth } from "@/lib/middleware";
import { Notification } from "@/models/notification";

export const GET = withAuth(async (_request, { user }) => {
  await connectDB();

  const count = await Notification.countDocuments({
    recipient: user._id,
    read: false,
    // Counting rows the list will not show would put a number on an empty bell
    inApp: { $ne: false },
  });

  return NextResponse.json({ count });
});
