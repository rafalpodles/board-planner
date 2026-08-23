import { NextResponse } from "next/server";
import { connectDB } from "@/lib/db";
import { withProjectAccess } from "@/lib/middleware";
import { User } from "@/models/user";
import { normaliseMatrix } from "@/lib/notification-prefs";

// Personal settings behind withProjectAccess rather than withProjectOwner: this is the reader's
// own preference, so every member has one. The gate is there to stop overrides being stored for
// projects the caller cannot see.

/** Enough for anyone tuning real boards, and a bound on a document every dispatch reads. */
const MAX_OVERRIDES = 200;

/**
 * Same rule as the global route, on both verbs. Removing an override widens delivery just as
 * surely as ticking a box does — the board falls back to the global grid — so gating only the
 * write left the other half open.
 */
function interactiveOnly(user: { viaMachineCredential?: boolean }) {
  return user.viaMachineCredential
    ? NextResponse.json({ error: "This action requires an interactive session" }, { status: 403 })
    : null;
}

export const PUT = withProjectAccess(async (request, { user, params }) => {
  const refusal = interactiveOnly(user);
  if (refusal) return refusal;

  const { projectId } = await params;
  await connectDB();

  const body = await request.json().catch(() => ({}));
  const matrix = normaliseMatrix(body?.matrix);

  // Whether chat can deliver is derived at read time from the connection, so an override may name
  // it freely: with nothing connected it simply resolves to off, and starts working if a webhook
  // appears. Refusing it here is what produced a screen that disabled the box it demanded you clear.

  // Update in place first. If there is no row yet, insert one — guarded both against a racing
  // insert (so two tabs cannot leave two rows for one project) and against the array's ceiling,
  // in the filter rather than from a count read beforehand, which bounded nothing under
  // concurrency because every racer saw the same pre-write length.
  const updated = await User.findOneAndUpdate(
    { _id: user._id, "notifications.projects.project": projectId },
    { $set: { "notifications.projects.$.matrix": matrix } }
  );
  if (updated) return NextResponse.json({ ok: true });

  const inserted = await User.findOneAndUpdate(
    {
      _id: user._id,
      "notifications.projects.project": { $ne: projectId },
      $expr: { $lt: [{ $size: { $ifNull: ["$notifications.projects", []] } }, MAX_OVERRIDES] },
    },
    { $push: { "notifications.projects": { project: projectId, matrix } } }
  );
  if (inserted) return NextResponse.json({ ok: true });

  // Nothing was written. Either a racing request inserted the row between the two statements — in
  // which case answering {ok:true} would report a save that did not happen — or the ceiling is
  // reached. Distinguishing them costs one read and is worth it: the two need different words.
  const after = await User.findById(user._id, "notifications.projects.project").lean();
  const count = after?.notifications?.projects?.length ?? 0;
  if (count >= MAX_OVERRIDES) {
    return NextResponse.json(
      { error: `A person may tune at most ${MAX_OVERRIDES} projects` },
      { status: 400 }
    );
  }
  return NextResponse.json(
    { error: "Somebody else saved this at the same moment — reload and try again" },
    { status: 409 }
  );
});

export const DELETE = withProjectAccess(async (_request, { user, params }) => {
  const refusal = interactiveOnly(user);
  if (refusal) return refusal;

  const { projectId } = await params;
  await connectDB();

  // Removing the row IS switching the override off — there is no separate flag to clear
  await User.findByIdAndUpdate(user._id, {
    $pull: { "notifications.projects": { project: projectId } },
  });

  return NextResponse.json({ ok: true });
});
