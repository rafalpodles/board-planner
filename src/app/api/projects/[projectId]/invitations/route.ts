import { NextResponse } from "next/server";
import { connectDB } from "@/lib/db";
import { readJsonBody } from "@/lib/request-body";
import { withProjectOwner } from "@/lib/middleware";
import { isValidEmail, normaliseEmail } from "@/lib/email";
import { isRateLimited, recordFailedAttempt } from "@/lib/rate-limit";
import { selfOrigin } from "@/lib/session";
import { inviteToBoard } from "@/lib/invitations";
import { deliverTo, INTERACTIVE_ONLY, NO_ORIGIN_ERROR } from "@/lib/invitation-mail";
import { logInstanceAudit } from "@/lib/instanceAudit";
import { logProjectAudit } from "@/lib/projectAudit";
import { Invitation } from "@/models/invitation";
import { Project } from "@/models/project";
import { User } from "@/models/user";
import { ApiBoardInvitation, GRANT_RELATIONS, GrantRelation } from "@/types";

// Each one may send mail to an address the sender chooses, so an owner gets a budget, not a hose
const INVITES_PER_OWNER = 30;

export const GET = withProjectOwner(async (_request, { params }) => {
  const { projectId } = await params;
  await connectDB();
  const pending = await Invitation.find({ status: "pending", "boards.project": projectId })
    .sort({ createdAt: -1 })
    .lean();
  const [held, adders] = await Promise.all([
    User.find({ email: { $in: pending.map((i) => i.email) } }).select("email").lean(),
    User.find({
      _id: { $in: pending.flatMap((i) => i.boards.map((b) => b.addedBy)) },
    })
      .select("username")
      .lean(),
  ]);
  const taken = new Set(held.map((u) => u.email));
  const usernameOf = new Map(adders.map((u) => [String(u._id), u.username]));
  const now = Date.now();

  const rows: ApiBoardInvitation[] = pending
    .filter((i) => !taken.has(i.email))
    .flatMap((i) => {
      const entry = i.boards.find((b) => String(b.project) === String(projectId));
      if (!entry) return [];
      return [
        {
          _id: String(i._id),
          email: i.email,
          relation: entry.relation,
          addedBy: usernameOf.get(String(entry.addedBy)) ?? null,
          expiresAt: new Date(i.expiresAt).toISOString(),
          expired: new Date(i.expiresAt).getTime() <= now,
        },
      ];
    });
  return NextResponse.json(rows);
});

export const POST = withProjectOwner(async (request, { params, user }) => {
  if (user.viaMachineCredential) {
    return NextResponse.json({ error: INTERACTIVE_ONLY }, { status: 403 });
  }
  const { projectId } = await params;

  const throttleKey = `board-invite:${String(user._id)}`;
  if (await isRateLimited(throttleKey, INVITES_PER_OWNER)) {
    return NextResponse.json({ error: "Too many invitations. Try again in 15 minutes." }, { status: 429 });
  }

  const read = await readJsonBody<{ email?: unknown; relation?: unknown }>(request);
  if (!read.ok) return read.response;
  const { email: rawEmail, relation = "member" } = read.value;
  if (typeof rawEmail !== "string" || !rawEmail.trim()) {
    return NextResponse.json({ error: "Enter the address to invite" }, { status: 400 });
  }
  const email = normaliseEmail(rawEmail);
  if (!isValidEmail(email)) {
    return NextResponse.json({ error: "That does not look like an email address" }, { status: 400 });
  }
  if (typeof relation !== "string" || !GRANT_RELATIONS.includes(relation as GrantRelation)) {
    return NextResponse.json({ error: "A board's relation is owner or member" }, { status: 400 });
  }

  const origin = selfOrigin();
  if (!origin) return NextResponse.json({ error: NO_ORIGIN_ERROR }, { status: 500 });

  await connectDB();
  if (await User.exists({ email })) {
    return NextResponse.json(
      { error: "That address already has an account. Add them from the list above." },
      { status: 409 }
    );
  }
  const project = await Project.findById(projectId).select("key name").lean();
  if (!project) return NextResponse.json({ error: "Project not found" }, { status: 404 });

  await recordFailedAttempt(throttleKey);
  const outcome = await inviteToBoard({
    email,
    project: projectId,
    relation: relation as GrantRelation,
    invitedBy: user._id,
  });

  void logProjectAudit(projectId, String(user._id), "member_invited", `${email}: invited as ${relation}`);

  if (outcome.kind === "added") {
    void logInstanceAudit({
      action: "invitation_sent",
      user: user._id,
      actorUsername: user.username,
      target: email,
      detail: `${project.key} (${relation}) added to the pending invitation`,
    });
    return NextResponse.json({ outcome: "added" }, { status: 200 });
  }

  const delivery = await deliverTo(
    email,
    outcome.token,
    origin,
    user,
    "member",
    [{ project: projectId, relation: relation as GrantRelation }],
    [project]
  );
  void logInstanceAudit({
    action: "invitation_sent",
    user: user._id,
    actorUsername: user.username,
    target: email,
    detail: `as a member, ${project.key} (${relation}), ${delivery.delivery === "email" ? "by email" : "as a link"}`,
  });
  return NextResponse.json({ outcome: "created", ...delivery }, { status: 201 });
});
