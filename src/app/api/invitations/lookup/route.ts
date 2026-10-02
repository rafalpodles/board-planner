import { NextResponse } from "next/server";
import { readJsonBody } from "@/lib/request-body";
import { getClientIp } from "@/lib/auth";
import { anonymousMultiplier, isRateLimited, recordFailedAttempt, sourceKey } from "@/lib/rate-limit";
import { provenanceRefusal } from "@/lib/session";
import { findInvitationByToken } from "@/lib/invitations";
import { INVITATION_REFUSALS } from "@/lib/invitation-refusals";
import { toApiInvitations } from "@/lib/invitation-view";

const LOOKUPS_PER_SOURCE = 60;

export async function POST(request: Request) {
  const refusal = provenanceRefusal(request);
  if (refusal) return refusal;

  const clientIp = getClientIp(request);
  const throttleKey = sourceKey(clientIp ?? "-", "invitation-lookup");
  if (await isRateLimited(throttleKey, anonymousMultiplier(clientIp, LOOKUPS_PER_SOURCE))) {
    return NextResponse.json({ error: "Too many attempts. Try again in 15 minutes." }, { status: 429 });
  }
  await recordFailedAttempt(throttleKey);

  const read = await readJsonBody<{ token?: unknown }>(request);
  if (!read.ok) return read.response;
  if (typeof read.value.token !== "string" || !read.value.token) {
    return NextResponse.json({ error: INVITATION_REFUSALS.unknown }, { status: 400 });
  }

  const found = await findInvitationByToken(read.value.token);
  if (!found.ok) {
    return NextResponse.json(
      { error: INVITATION_REFUSALS[found.reason], reason: found.reason },
      { status: 400 }
    );
  }
  const [view] = await toApiInvitations([found.invitation]);
  return NextResponse.json({
    email: view.email,
    role: view.role,
    boards: view.boards.map(({ name, relation }) => ({ name, relation })),
    invitedBy: view.invitedBy ? view.invitedBy.fullName || view.invitedBy.username : null,
    expiresAt: view.expiresAt,
  });
}
