import { NextResponse } from "next/server";
import { readJsonBody } from "@/lib/request-body";
import { getClientIp } from "@/lib/auth";
import { isRateLimited, recordFailedAttempt, sourceKey } from "@/lib/rate-limit";
import { provenanceRefusal } from "@/lib/session";
import { findInvitationByToken } from "@/lib/invitations";
import { INVITATION_REFUSALS } from "@/lib/invitation-refusals";
import { toApiInvitations } from "@/lib/invitation-view";
import { User } from "@/models/user";

const LOOKUPS_PER_SOURCE = 60;

export async function POST(request: Request) {
  const refusal = provenanceRefusal(request);
  if (refusal) return refusal;

  const clientIp = getClientIp(request);
  // The link is the secret, and a bucket shared by every caller with no address would only let
  // anybody stop every invitation being used (BP-840)
  const throttleKey = clientIp ? sourceKey(clientIp, "invitation-lookup") : null;
  if (throttleKey) {
    if (await isRateLimited(throttleKey, LOOKUPS_PER_SOURCE)) {
      return NextResponse.json({ error: "Too many attempts. Try again in 15 minutes." }, { status: 429 });
    }
    await recordFailedAttempt(throttleKey);
  }

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
  // Refused without being withdrawn: an address held without confirmation proves nothing, and the
  // invitation is valid again once it is released
  if (await User.exists({ email: found.invitation.email })) {
    return NextResponse.json(
      { error: INVITATION_REFUSALS.used, reason: "used" },
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
