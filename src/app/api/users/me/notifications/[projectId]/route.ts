import { NextResponse } from "next/server";
import { connectDB } from "@/lib/db";
import { withProjectAccess } from "@/lib/middleware";
import { User } from "@/models/user";
import { normaliseMatrix } from "@/lib/notification-prefs";

const MAX_OVERRIDES = 200;

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

  await User.findByIdAndUpdate(user._id, {
    $pull: { "notifications.projects": { project: projectId } },
  });

  return NextResponse.json({ ok: true });
});
