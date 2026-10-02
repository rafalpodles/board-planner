import { NextResponse } from "next/server";
import { connectDB } from "@/lib/db";
import { readJsonBody } from "@/lib/request-body";
import { withProjectOwner } from "@/lib/middleware";
import { isValidEmail, normaliseEmail } from "@/lib/email";
import { isRateLimited, recordFailedAttempt } from "@/lib/rate-limit";
import { selfOrigin } from "@/lib/session";
import { inviteToBoard, recordDelivery } from "@/lib/invitations";
import { deliverTo, INTERACTIVE_ONLY, NO_ORIGIN_ERROR } from "@/lib/invitation-mail";
import { logInstanceAudit } from "@/lib/instanceAudit";
import { logProjectAudit } from "@/lib/projectAudit";
import { Invitation } from "@/models/invitation";
import { Project } from "@/models/project";
import { User } from "@/models/user";
import { ApiBoardInvitation, GRANT_RELATIONS, GrantRelation } from "@/types";

// Each one may send mail to an address the sender chooses, so an owner gets a budget, not a hose;
// and one address gets a ceiling of its own, however many owners take turns
const INVITES_PER_OWNER = 30;
const INVITES_PER_ADDRESS = 5;

export const GET = withProjectOwner(async (_request, { params, user }) => {
  if (user.viaMachineCredential) {
    return NextResponse.json({ error: INTERACTIVE_ONLY }, { status: 403 });
  }
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

  const ownerKey = `board-invite:${String(user._id)}`;
  if (await isRateLimited(ownerKey, INVITES_PER_OWNER)) {
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
  const project = await Project.findById(projectId).select("key name").lean();
  if (!project) return NextResponse.json({ error: "Project not found" }, { status: 404 });

  // Spent before the account check, so the answer to "does this address have an account" is
  // budgeted like everything else this route answers
  await recordFailedAttempt(ownerKey);
  if (await User.exists({ email })) {
    return NextResponse.json(
      { error: "That address already has an account. Add them by username above." },
      { status: 409 }
    );
  }

  const addressKey = `board-invite-to:${email}`;
  if (await isRateLimited(addressKey, INVITES_PER_ADDRESS)) {
    return NextResponse.json(
      { error: "That address has been invited too often. Try again in 15 minutes." },
      { status: 429 }
    );
  }

  const outcome = await inviteToBoard({
    email,
    project: projectId,
    relation: relation as GrantRelation,
    invitedBy: user._id,
  });

  if (outcome.kind === "held") {
    const inviter = await User.findById(outcome.invitedBy).select("username").lean();
    return NextResponse.json(
      {
        error: `${email} already has an invitation${inviter ? ` from ${inviter.username}` : ""} that this board cannot join. Add them by username once they have joined.`,
      },
      { status: 409 }
    );
  }

  if (outcome.kind !== "created") {
    void logProjectAudit(
      projectId,
      String(user._id),
      "member_invited",
      outcome.kind === "added"
        ? `${email}: added to the pending invitation as ${relation}`
        : `${email}: invitation to this board now as ${relation}`
    );
    return NextResponse.json({ outcome: outcome.kind });
  }

  await recordFailedAttempt(addressKey);
  const delivery = await deliverTo(
    email,
    outcome.token,
    origin,
    user,
    "member",
    [{ project: projectId, relation: relation as GrantRelation }],
    [project]
  );
  await recordDelivery(outcome.invitation._id, outcome.token, delivery.delivery);

  void logProjectAudit(projectId, String(user._id), "member_invited", `${email}: invited as ${relation}`);
  void logInstanceAudit({
    action: "invitation_sent",
    user: user._id,
    actorUsername: user.username,
    target: email,
    detail: `as a member, ${project.key} (${relation}), ${delivery.delivery === "email" ? "by email" : "as a link"}`,
  });
  return NextResponse.json({ outcome: "created", ...delivery }, { status: 201 });
});
