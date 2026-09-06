import { NextResponse } from "next/server";
import { isValidObjectId } from "mongoose";
import { connectDB } from "@/lib/db";
import { withAuth } from "@/lib/middleware";
import { Notification } from "@/models/notification";

export const PATCH = withAuth(async (request, { user }) => {
  await connectDB();

  const body = await request.json().catch(() => ({}));
  const { id } = body as { id?: unknown };

  if (id !== undefined) {
    if (typeof id !== "string" || !isValidObjectId(id)) {
      return NextResponse.json({ error: "Invalid notification id" }, { status: 400 });
    }

    await Notification.findOneAndUpdate(
      { _id: id, recipient: user._id, inApp: { $ne: false } },
      { $set: { read: true } }
    );
  } else {
    await Notification.updateMany(
      { recipient: user._id, read: false, inApp: { $ne: false } },
      { $set: { read: true } }
    );
  }

  return NextResponse.json({ ok: true });
});
