import { NextResponse } from "next/server";
import { isValidObjectId, Types } from "mongoose";
import { connectDB } from "@/lib/db";
import { readJsonBody } from "@/lib/request-body";
import { withAdmin } from "@/lib/middleware";
import { isValidEmail, normaliseEmail } from "@/lib/email";
import { selfOrigin } from "@/lib/session";
import { issueInvitation, InvitationBoardInput, recordDelivery } from "@/lib/invitations";
import { deliverTo, INTERACTIVE_ONLY, NO_ORIGIN_ERROR } from "@/lib/invitation-mail";
import { describeInvitation, toApiInvitations } from "@/lib/invitation-view";
import { logInstanceAudit } from "@/lib/instanceAudit";
import { GRANT_RELATIONS, GrantRelation } from "@/types";

const MAX_BOARDS = 100;


export const GET = withAdmin(async (_request, { user, db }) => {
  if (user.viaMachineCredential) {
    return NextResponse.json({ error: INTERACTIVE_ONLY }, { status: 403 });
  }
  await connectDB();
  const pending = await db.Invitation.find({ status: "pending" }).sort({ createdAt: -1 }).lean();
  const taken = new Set(
    (await db.User.find({ email: { $in: pending.map((i) => i.email) } }).select("email").lean()).map(
      (u) => u.email
    )
  );
  return NextResponse.json(await toApiInvitations(db, pending.filter((i) => !taken.has(i.email))));
});

type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

function parseBoards(raw: unknown): Parsed<InvitationBoardInput[]> {
  if (raw === undefined) return { ok: true, value: [] };
  if (!Array.isArray(raw) || raw.length > MAX_BOARDS) {
    return { ok: false, error: `boards must be a list of at most ${MAX_BOARDS}` };
  }
  const byProject = new Map<string, GrantRelation>();
  for (const entry of raw) {
    const { project, relation } = (entry ?? {}) as { project?: unknown; relation?: unknown };
    if (typeof project !== "string" || !isValidObjectId(project)) {
      return { ok: false, error: "Every board needs a project id" };
    }
    if (typeof relation !== "string" || !GRANT_RELATIONS.includes(relation as GrantRelation)) {
      return { ok: false, error: "A board's relation is owner or member" };
    }
    byProject.set(new Types.ObjectId(project).toString(), relation as GrantRelation);
  }
  return {
    ok: true,
    value: [...byProject].map(([project, relation]) => ({ project, relation })),
  };
}

export const POST = withAdmin(async (request, { user, db }) => {
  if (user.viaMachineCredential) {
    return NextResponse.json({ error: INTERACTIVE_ONLY }, { status: 403 });
  }
  const read = await readJsonBody<{ email?: unknown; role?: unknown; boards?: unknown }>(request);
  if (!read.ok) return read.response;
  const body = read.value;

  if (typeof body.email !== "string" || !body.email.trim()) {
    return NextResponse.json({ error: "Enter the address to invite" }, { status: 400 });
  }
  const email = normaliseEmail(body.email);
  if (!isValidEmail(email)) {
    return NextResponse.json({ error: "That does not look like an email address" }, { status: 400 });
  }
  const role = body.role ?? "member";
  if (role !== "admin" && role !== "member") {
    return NextResponse.json({ error: "Invalid role" }, { status: 400 });
  }
  const boards = parseBoards(body.boards);
  if (!boards.ok) return NextResponse.json({ error: boards.error }, { status: 400 });

  const origin = selfOrigin();
  if (!origin) return NextResponse.json({ error: NO_ORIGIN_ERROR }, { status: 500 });

  await connectDB();
  if (await db.User.exists({ email })) {
    return NextResponse.json(
      { error: "That address already has an account. Add them to a board instead." },
      { status: 409 }
    );
  }
  const projects = await db.Project.find({ _id: { $in: boards.value.map((b) => b.project) } })
    .select("key name")
    .lean();
  if (projects.length !== boards.value.length) {
    return NextResponse.json({ error: "One of those boards does not exist" }, { status: 400 });
  }

  const { invitation, token } = await issueInvitation(db, {
    email,
    role,
    boards: boards.value,
    invitedBy: user._id,
  });
  const delivery = await deliverTo(invitation.email, token, origin, user, role, boards.value, projects);
  await recordDelivery(db, invitation._id, token, delivery.delivery);

  void logInstanceAudit(db, {
    action: "invitation_sent",
    user: user._id,
    actorUsername: user.username,
    target: email,
    detail: describeInvitation(role, boards.value, projects, delivery.delivery),
  });

  const [view] = await toApiInvitations(db, [invitation]);
  return NextResponse.json({ invitation: view, ...delivery }, { status: 201 });
});
