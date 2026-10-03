import { NextResponse } from "next/server";
import { isValidObjectId } from "mongoose";
import { withAdmin } from "@/lib/middleware";
import { selfOrigin } from "@/lib/session";
import { recordDelivery, reissueInvitation } from "@/lib/invitations";
import { deliverTo, INTERACTIVE_ONLY, NO_ORIGIN_ERROR } from "@/lib/invitation-mail";
import { describeInvitation, toApiInvitations } from "@/lib/invitation-view";
import { logInstanceAudit } from "@/lib/instanceAudit";
import { Invitation } from "@/models/invitation";
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

  const current = await Invitation.findById(invitationId).select("email").lean();
  if (current && (await User.exists({ email: current.email }))) {
    return NextResponse.json(
      { error: "That address already has an account. Add them to a board instead." },
      { status: 409 }
    );
  }
  const reissued = await reissueInvitation(invitationId, user._id);
  if (!reissued) return NextResponse.json({ error: "Invitation not found" }, { status: 404 });
  const { invitation, token, dropped } = reissued;

  const projects = await Project.find({ _id: { $in: invitation.boards.map((b) => b.project) } })
    .select("key name")
    .lean();
  const delivery = await deliverTo(
    invitation.email,
    token,
    origin,
    user,
    invitation.role,
    invitation.boards,
    projects
  );
  await recordDelivery(invitation._id, token, delivery.delivery);

  void logInstanceAudit({
    action: "invitation_resent",
    user: user._id,
    actorUsername: user.username,
    target: invitation.email,
    detail: describeInvitation(invitation.role, invitation.boards, projects, delivery.delivery),
  });

  const [view] = await toApiInvitations([invitation]);
  // Named, since nobody chose to drop them: their adders can no longer grant them (BP-843)
  const droppedBoards = dropped.length
    ? (await Project.find({ _id: { $in: dropped.map((b) => b.project) } }).select("key name").lean()).map((p) => p.name)
    : [];
  return NextResponse.json({ invitation: view, ...delivery, dropped: droppedBoards });
});
