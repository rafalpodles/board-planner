import { NextResponse } from "next/server";
import { connectDB } from "@/lib/db";
import { withAuth } from "@/lib/middleware";
import { User } from "@/models/user";

export const PUT = withAuth(async (request, { user }) => {
  await connectDB();

  const body = await request.json();
  const updates: Record<string, unknown> = {};

  if (typeof body.email === "string") {
    updates.email = body.email.trim().toLowerCase();
  }
  if (typeof body.emailNotifications === "boolean") {
    updates.emailNotifications = body.emailNotifications;
  }

  if (Object.keys(updates).length === 0) {
    return NextResponse.json({ error: "No valid fields to update" }, { status: 400 });
  }

  const updated = await User.findByIdAndUpdate(
    user._id,
    { $set: updates },
    { new: true }
  );

  return NextResponse.json(updated);
});
