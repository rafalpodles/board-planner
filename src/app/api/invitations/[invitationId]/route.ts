import { NextResponse } from "next/server";
import { isValidObjectId } from "mongoose";
import { withAdmin } from "@/lib/middleware";
import { revokeInvitation } from "@/lib/invitations";
import { logInstanceAudit } from "@/lib/instanceAudit";

export const DELETE = withAdmin(async (_request, { params, user }) => {
  const { invitationId } = await params;
  if (!isValidObjectId(invitationId)) {
    return NextResponse.json({ error: "Invitation not found" }, { status: 404 });
  }
  const revoked = await revokeInvitation(invitationId);
  if (!revoked) return NextResponse.json({ error: "Invitation not found" }, { status: 404 });

  void logInstanceAudit({
    action: "invitation_revoked",
    user: user._id,
    actorUsername: user.username,
    target: revoked.email,
  });
  return NextResponse.json({ ok: true });
});
