import { NextResponse } from "next/server";
import { connectDB } from "@/lib/db";
import { withAuth } from "@/lib/middleware";
import { Notification } from "@/models/notification";

export const GET = withAuth(async (_request, { user }) => {
  await connectDB();

  const count = await Notification.countDocuments({
    recipient: user._id,
    read: false,
  });

  return NextResponse.json({ count });
});
