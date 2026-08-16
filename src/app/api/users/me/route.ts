import { NextResponse } from "next/server";
import { connectDB } from "@/lib/db";
import { isValidEmail, normaliseEmail } from "@/lib/email";
import { withAuth } from "@/lib/middleware";
import { duplicateKeyField } from "@/lib/mongo-errors";
import { User } from "@/models/user";

export const PUT = withAuth(async (request, { user }) => {
  await connectDB();

  const body = await request.json();
  const updates: Record<string, unknown> = {};

  if (typeof body.email === "string") {
    const email = normaliseEmail(body.email);
    // Same rule as the admin path: an address nobody can deliver to is worse than none, because
    // the reset it is meant to receive will look like it was sent
    if (email && !isValidEmail(email)) {
      return NextResponse.json(
        { error: "That does not look like an email address" },
        { status: 400 }
      );
    }
    updates.email = email;
  }
  if (typeof body.emailNotifications === "boolean") {
    updates.emailNotifications = body.emailNotifications;
  }
  if (typeof body.collapseEmptyColumns === "boolean") {
    updates.collapseEmptyColumns = body.collapseEmptyColumns;
  }

  if (Object.keys(updates).length === 0) {
    return NextResponse.json({ error: "No valid fields to update" }, { status: 400 });
  }

  let updated;
  try {
    updated = await User.findByIdAndUpdate(
      user._id,
      { $set: updates },
      { returnDocument: "after" }
    );
  } catch (err) {
    if (duplicateKeyField(err) === "email") {
      return NextResponse.json(
        { error: "That email is already on another account" },
        { status: 409 }
      );
    }
    throw err;
  }

  return NextResponse.json(updated);
});
