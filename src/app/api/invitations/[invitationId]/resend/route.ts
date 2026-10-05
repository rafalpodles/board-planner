import { NextResponse } from "next/server";
import { isValidObjectId } from "mongoose";
import { withAdmin } from "@/lib/middleware";
import { originFor } from "@/lib/organisation-host";
import { recordDelivery, reissueInvitation } from "@/lib/invitations";
import { deliverTo, INTERACTIVE_ONLY, invitationLink, NO_ORIGIN_ERROR } from "@/lib/invitation-mail";
import { describeInvitation, toApiInvitations } from "@/lib/invitation-view";
import { logInstanceAudit } from "@/lib/instanceAudit";
import { InvitationDelivery } from "@/types";

export const POST = withAdmin(async (request, { params, user, db }) => {
  if (user.viaMachineCredential) {
    return NextResponse.json({ error: INTERACTIVE_ONLY }, { status: 403 });
  }
  const { invitationId } = await params;
  if (!isValidObjectId(invitationId)) {
    return NextResponse.json({ error: "Invitation not found" }, { status: 404 });
  }
  const body = (await request.json().catch(() => ({}))) as { delivery?: unknown };
  if (body.delivery !== undefined && body.delivery !== "email" && body.delivery !== "link") {
    return NextResponse.json({ error: 'delivery must be "email" or "link"' }, { status: 400 });
  }
  const linkOnly = body.delivery === "link";
  const origin = await originFor(db);
  if (!origin) return NextResponse.json({ error: NO_ORIGIN_ERROR }, { status: 500 });

  const current = await db.Invitation.findById(invitationId).select("email").lean();
  if (current && (await db.User.exists({ email: current.email }))) {
    return NextResponse.json(
      { error: "That address already has an account. Add them to a board instead." },
      { status: 409 }
    );
  }
  const reissued = await reissueInvitation(db, invitationId, user._id);
  if (!reissued) return NextResponse.json({ error: "Invitation not found" }, { status: 404 });
  const { invitation, token, dropped } = reissued;

  const projects = await db.Project.find({ _id: { $in: invitation.boards.map((b) => b.project) } })
    .select("key name")
    .lean();
  const delivery: InvitationDelivery = linkOnly
    ? { delivery: "link", link: invitationLink(origin, token), reason: "requested" }
    : await deliverTo(invitation.email, token, origin, user, invitation.role, invitation.boards, projects);
  await recordDelivery(db, invitation._id, token, delivery.delivery);

  void logInstanceAudit(db, {
    action: linkOnly ? "invitation_link_issued" : "invitation_resent",
    user: user._id,
    actorUsername: user.username,
    target: invitation.email,
    detail: describeInvitation(invitation.role, invitation.boards, projects, delivery.delivery),
  });

  const [view] = await toApiInvitations(db, [invitation]);
  // Named, since nobody chose to drop them: their adders can no longer grant them (BP-843)
  const droppedBoards = dropped.length
    ? (await db.Project.find({ _id: { $in: dropped.map((b) => b.project) } }).select("key name").lean()).map((p) => p.name)
    : [];
  return NextResponse.json({ invitation: view, ...delivery, dropped: droppedBoards });
});
