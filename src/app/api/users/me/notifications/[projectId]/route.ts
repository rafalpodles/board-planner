import { NextResponse } from "next/server";
import { connectDB } from "@/lib/db";
import { withProjectAccess } from "@/lib/middleware";
import { User } from "@/models/user";
import { normaliseMatrix, wantsChat } from "@/lib/notification-prefs";

// Personal settings behind withProjectAccess rather than withProjectOwner: this is the reader's
// own preference, so every member has one. The gate is there to stop overrides being stored for
// projects the caller cannot see.

/** Enough for anyone tuning real boards, and a bound on a document every dispatch reads. */
const MAX_OVERRIDES = 200;

export const PUT = withProjectAccess(async (request, { user, params }) => {
  const { projectId } = await params;
  await connectDB();

  const body = await request.json().catch(() => ({}));
  const matrix = normaliseMatrix(body?.matrix);

  const stored = await User.findById(user._id, "notifications").lean();
  if (wantsChat(matrix) && !stored?.notifications?.chat?.kind) {
    // Storing this would tick a column that delivers nowhere, and nothing downstream would say so
    return NextResponse.json(
      { error: "Connect Slack or Discord before sending anything there" },
      { status: 400 }
    );
  }

  // Updating in place first, then inserting only where no row exists yet. Two round trips, but
  // each one is atomic and the insert is guarded, so two tabs saving at once cannot leave two
  // rows for one project — which the earlier $pull-then-$push could, and `overrideFor` would then
  // obey whichever landed first.
  const updated = await User.findOneAndUpdate(
    { _id: user._id, "notifications.projects.project": projectId },
    { $set: { "notifications.projects.$.matrix": matrix } }
  );
  if (!updated) {
    const count = stored?.notifications?.projects?.length ?? 0;
    if (count >= MAX_OVERRIDES) {
      return NextResponse.json(
        { error: `A person may tune at most ${MAX_OVERRIDES} projects` },
        { status: 400 }
      );
    }
    await User.findOneAndUpdate(
      { _id: user._id, "notifications.projects.project": { $ne: projectId } },
      { $push: { "notifications.projects": { project: projectId, matrix } } }
    );
  }

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
