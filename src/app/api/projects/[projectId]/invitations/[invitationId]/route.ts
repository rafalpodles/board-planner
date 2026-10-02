import { NextResponse } from "next/server";
import { isValidObjectId } from "mongoose";
import { withProjectOwner } from "@/lib/middleware";
import { removeBoardFromInvitation, revokeIfEmpty } from "@/lib/invitations";
import { logProjectAudit } from "@/lib/projectAudit";
import { User } from "@/models/user";

export const DELETE = withProjectOwner(async (_request, { params, user }) => {
  const { projectId, invitationId } = await params;
  if (!isValidObjectId(invitationId)) {
    return NextResponse.json({ error: "Invitation not found" }, { status: 404 });
  }
  const updated = await removeBoardFromInvitation(invitationId, projectId);
  if (!updated) return NextResponse.json({ error: "Invitation not found" }, { status: 404 });

  // An administrator's invitation keeps its role with no boards left; anybody else's had only
  // boards to give, so it goes
  if (updated.boards.length === 0) {
    const inviter = await User.findById(updated.invitedBy).select("role kind").lean();
    if (!(inviter?.role === "admin" && inviter.kind !== "machine")) await revokeIfEmpty(updated._id);
  }

  void logProjectAudit(
    projectId,
    String(user._id),
    "member_invitation_removed",
    `${updated.email}: invitation to this board withdrawn`
  );
  return NextResponse.json({ ok: true });
});
