import { NextResponse } from "next/server";
import { connectDB } from "@/lib/db";
import { withProjectAccess } from "@/lib/middleware";
import { User } from "@/models/user";
import { normaliseMatrix } from "@/lib/notification-prefs";

// Personal settings behind withProjectAccess rather than withProjectOwner: this is the reader's
// own preference, so every member has one. The gate is there to stop overrides being stored for
// projects the caller cannot see.

export const PUT = withProjectAccess(async (request, { user, params }) => {
  const { projectId } = await params;
  await connectDB();

  const body = await request.json().catch(() => ({}));
  const matrix = normaliseMatrix(body?.matrix);

  // Two writes rather than an arrayFilter: 4.4 handles $pull and $push predictably, and a row
  // that does not exist yet makes a positional update a special case for no gain.
  await User.findByIdAndUpdate(user._id, {
    $pull: { "notifications.projects": { project: projectId } },
  });
  await User.findByIdAndUpdate(user._id, {
    $push: { "notifications.projects": { project: projectId, matrix } },
  });

  return NextResponse.json({ ok: true });
});

export const DELETE = withProjectAccess(async (_request, { user, params }) => {
  const { projectId } = await params;
  await connectDB();

  // Removing the row IS switching the override off — there is no separate flag to clear
  await User.findByIdAndUpdate(user._id, {
    $pull: { "notifications.projects": { project: projectId } },
  });

  return NextResponse.json({ ok: true });
});
