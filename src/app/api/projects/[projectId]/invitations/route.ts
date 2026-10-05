import { NextResponse } from "next/server";
import { connectDB } from "@/lib/db";
import { readJsonBody } from "@/lib/request-body";
import { withProjectOwner } from "@/lib/middleware";
import { isValidEmail, normaliseEmail } from "@/lib/email";
import { isRateLimited, recordFailedAttempt } from "@/lib/rate-limit";
import { originFor } from "@/lib/organisation-host";
import { inviteToBoard, recordDelivery } from "@/lib/invitations";
import { deliverTo, INTERACTIVE_ONLY, NO_ORIGIN_ERROR } from "@/lib/invitation-mail";
import { logInstanceAudit } from "@/lib/instanceAudit";
import { logProjectAudit } from "@/lib/projectAudit";
import { ApiBoardInvitation, GRANT_RELATIONS, GrantRelation } from "@/types";

// Each one may send mail to an address the sender chooses, so an owner gets a budget, not a hose;
// and one address gets a ceiling of its own, however many owners take turns
const INVITES_PER_OWNER = 30;
const INVITES_PER_ADDRESS = 5;
// Across every organisation, so the address's inbox keeps a ceiling however many organisations there are
const INVITES_PER_ADDRESS_EVERYWHERE = 20;

export const GET = withProjectOwner(async (_request, { params, user, db }) => {
  if (user.viaMachineCredential) {
    return NextResponse.json({ error: INTERACTIVE_ONLY }, { status: 403 });
  }
  const { projectId } = await params;
  await connectDB();
  const pending = await db.Invitation.find({ status: "pending", "boards.project": projectId })
    .sort({ createdAt: -1 })
    .lean();
  const [held, adders] = await Promise.all([
    db.User.find({ email: { $in: pending.map((i) => i.email) } }).select("email").lean(),
    db.User.find({
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

export const POST = withProjectOwner(async (request, { params, user, db }) => {
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

  const origin = await originFor(db);
  if (!origin) return NextResponse.json({ error: NO_ORIGIN_ERROR }, { status: 500 });

  await connectDB();
  const project = await db.Project.findById(projectId).select("key name").lean();
  if (!project) return NextResponse.json({ error: "Project not found" }, { status: 404 });

  // Spent before the account check, so the answer to "does this address have an account" is
  // budgeted like everything else this route answers
  await recordFailedAttempt(ownerKey);
  if (await db.User.exists({ email })) {
    return NextResponse.json(
      { error: "That address already has an account. Add them by username above." },
      { status: 409 }
    );
  }

  const addressKey = `board-invite-to:${db.organisation.toHexString()}:${email}`;
  const inboxKey = `board-invite-to:${email}`;
  if (
    (await isRateLimited(addressKey, INVITES_PER_ADDRESS)) ||
    (await isRateLimited(inboxKey, INVITES_PER_ADDRESS_EVERYWHERE))
  ) {
    return NextResponse.json(
      { error: "That address has been invited too often. Try again in 15 minutes." },
      { status: 429 }
    );
  }

  const outcome = await inviteToBoard(db, {
    email,
    project: projectId,
    relation: relation as GrantRelation,
    invitedBy: user._id,
  });

  if (outcome.kind === "held") {
    const inviter = await db.User.findById(outcome.invitedBy).select("username deactivatedAt").lean();
    // Nobody joins through a lapsed invitation, so waiting for them to join would be waiting for ever.
    // Only an administrator resends; its sender, while active, can withdraw their own board
    const from = inviter ? ` from ${inviter.username}` : "";
    const withdrawer = inviter && !inviter.deactivatedAt ? `, or ${inviter.username} to withdraw it` : "";
    const error = outcome.expired
      ? `${email}'s invitation${from} has expired. Ask an administrator to send it again or revoke it${withdrawer}, then invite them here.`
      : `${email} already has an invitation${from} that this board cannot join. Add them by username once they have joined.`;
    return NextResponse.json({ error }, { status: 409 });
  }

  if (outcome.kind !== "created") {
    void logProjectAudit(
      db,
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
  await recordFailedAttempt(inboxKey);
  const delivery = await deliverTo(
    email,
    outcome.token,
    origin,
    user,
    "member",
    [{ project: projectId, relation: relation as GrantRelation }],
    [project]
  );
  await recordDelivery(db, outcome.invitation._id, outcome.token, delivery.delivery);

  void logProjectAudit(db, projectId, String(user._id), "member_invited", `${email}: invited as ${relation}`);
  void logInstanceAudit(db, {
    action: "invitation_sent",
    user: user._id,
    actorUsername: user.username,
    target: email,
    detail: `as a member, ${project.key} (${relation}), ${delivery.delivery === "email" ? "by email" : "as a link"}`,
  });
  return NextResponse.json({ outcome: "created", ...delivery }, { status: 201 });
});
