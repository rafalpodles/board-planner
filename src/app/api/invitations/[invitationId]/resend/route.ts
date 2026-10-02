import { NextResponse } from "next/server";
import { isValidObjectId } from "mongoose";
import { withAdmin } from "@/lib/middleware";
import { selfOrigin } from "@/lib/session";
import { reissueInvitation } from "@/lib/invitations";
import { deliverTo, INTERACTIVE_ONLY, NO_ORIGIN_ERROR } from "@/lib/invitation-mail";
import { describeInvitation, toApiInvitations } from "@/lib/invitation-view";
import { logInstanceAudit } from "@/lib/instanceAudit";
import { Project } from "@/models/project";
import { User } from "@/models/user";

export const POST = withAdmin(async (_request, { params, user }) => {
  if (user.viaMachineCredential) {
    return NextResponse.json({ error: INTERACTIVE_ONLY }, { status: 403 });
  }
  const { invitationId } = await params;
  if (!isValidObjectId(invitationId)) {
    return NextResponse.json({ error: "Invitation not found" }, { status: 404 });
  }
  const origin = selfOrigin();
  if (!origin) return NextResponse.json({ error: NO_ORIGIN_ERROR }, { status: 500 });

  const reissued = await reissueInvitation(invitationId);
  if (!reissued) return NextResponse.json({ error: "Invitation not found" }, { status: 404 });
  const { invitation, token } = reissued;

  const [projects, inviter] = await Promise.all([
    Project.find({ _id: { $in: invitation.boards.map((b) => b.project) } })
      .select("key name")
      .lean(),
    User.findById(invitation.invitedBy).select("username fullName").lean(),
  ]);
  const delivery = await deliverTo(
    invitation.email,
    token,
    origin,
    inviter ?? user,
    invitation.role,
    invitation.boards,
    projects
  );

  void logInstanceAudit({
    action: "invitation_resent",
    user: user._id,
    actorUsername: user.username,
    target: invitation.email,
    detail: describeInvitation(invitation.role, invitation.boards, projects, delivery.delivery),
  });

  const [view] = await toApiInvitations([invitation]);
  return NextResponse.json({ invitation: view, ...delivery });
});
