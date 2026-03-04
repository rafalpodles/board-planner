import { NextResponse } from "next/server";
import { connectDB } from "@/lib/db";
import { withAuth } from "@/lib/middleware";
import { Notification } from "@/models/notification";

export const PATCH = withAuth(async (request, { user }) => {
  await connectDB();

  const body = await request.json().catch(() => ({}));
  const { id } = body as { id?: string };

  if (id) {
    // Mark single notification as read
    await Notification.findOneAndUpdate(
      { _id: id, recipient: user._id },
      { $set: { read: true } }
    );
  } else {
    // Mark all as read
    await Notification.updateMany(
      { recipient: user._id, read: false },
      { $set: { read: true } }
    );
  }

  return NextResponse.json({ ok: true });
});
