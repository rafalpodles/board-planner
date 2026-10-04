import { NextResponse } from "next/server";
import { isValidObjectId } from "mongoose";
import { withProjectOwner } from "@/lib/middleware";
import { removeBoardFromInvitation, revokeIfEmpty } from "@/lib/invitations";
import { INTERACTIVE_ONLY } from "@/lib/invitation-mail";
import { logInstanceAudit } from "@/lib/instanceAudit";
import { logProjectAudit } from "@/lib/projectAudit";

export const DELETE = withProjectOwner(async (_request, { params, user, db }) => {
  if (user.viaMachineCredential) {
    return NextResponse.json({ error: INTERACTIVE_ONLY }, { status: 403 });
  }
  const { projectId, invitationId } = await params;
  if (!isValidObjectId(invitationId)) {
    return NextResponse.json({ error: "Invitation not found" }, { status: 404 });
  }
  const updated = await removeBoardFromInvitation(db, invitationId, projectId);
  if (!updated) return NextResponse.json({ error: "Invitation not found" }, { status: 404 });

  void logProjectAudit(
    db,
    projectId,
    String(user._id),
    "member_invitation_removed",
    `${updated.email}: invitation to this board withdrawn`
  );

  // An administrator's invitation keeps its role with no boards left; anybody else's had only
  // boards to give, so it goes
  if (updated.boards.length === 0) {
    const inviter = await db.User.findById(updated.invitedBy).select("role kind").lean();
    const keepsARole = inviter?.role === "admin" && inviter.kind !== "machine";
    if (!keepsARole && (await revokeIfEmpty(db, updated))) {
      void logInstanceAudit(db, {
        action: "invitation_revoked",
        user: user._id,
        actorUsername: user.username,
        target: updated.email,
        detail: "its last board was withdrawn by a board owner",
      });
    }
  }
  return NextResponse.json({ ok: true });
});
