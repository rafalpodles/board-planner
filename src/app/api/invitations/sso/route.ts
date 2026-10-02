import { NextResponse } from "next/server";
import { readJsonBody } from "@/lib/request-body";
import { getClientIp } from "@/lib/auth";
import { anonymousMultiplier, isRateLimited, recordFailedAttempt, sourceKey } from "@/lib/rate-limit";
import { buildFlowCookie, provenanceRefusal, readFlowCookie } from "@/lib/session";
import { checkProfile } from "@/lib/new-account";
import { claimInvitationByHash, releaseInvitation } from "@/lib/invitations";
import { INVITATION_REFUSALS } from "@/lib/invitation-refusals";
import { toApiInvitations } from "@/lib/invitation-view";
import { completeAcceptance } from "@/lib/invitation-acceptance";
import { ACCEPT_COOKIE, heldAcceptance, spendAcceptance } from "@/lib/oidc/flow";
import { providerById } from "@/lib/oidc/providers";
import { Invitation } from "@/models/invitation";

const ATTEMPTS_PER_SOURCE = 20;
const EXPIRED = "That sign-in has expired. Open the invitation link again.";

/** The invitation a verified sign-in is waiting to accept, read without spending anything. */
export async function GET(request: Request) {
  const held = await heldAcceptance(readFlowCookie(request, ACCEPT_COOKIE));
  if (!held?.claims) return NextResponse.json({ error: EXPIRED }, { status: 400 });
  const invitation = await Invitation.findOne({
    tokenHash: held.invitationTokenHash,
    status: "pending",
    expiresAt: { $gt: new Date() },
  }).lean();
  if (!invitation) return NextResponse.json({ error: INVITATION_REFUSALS.revoked }, { status: 400 });
  const [view] = await toApiInvitations([invitation]);
  return NextResponse.json({
    email: view.email,
    role: view.role,
    boards: view.boards.map(({ name, relation }) => ({ name, relation })),
    invitedBy: view.invitedBy ? view.invitedBy.fullName || view.invitedBy.username : null,
    provider: providerById(held.provider)?.label ?? held.provider,
  });
}

export async function POST(request: Request) {
  const refusal = provenanceRefusal(request);
  if (refusal) return refusal;

  const clientIp = getClientIp(request);
  const throttleKey = sourceKey(clientIp ?? "-", "invitation-use");
  if (await isRateLimited(throttleKey, anonymousMultiplier(clientIp, ATTEMPTS_PER_SOURCE))) {
    return NextResponse.json({ error: "Too many attempts. Try again in 15 minutes." }, { status: 429 });
  }
  await recordFailedAttempt(throttleKey);

  const binder = readFlowCookie(request, ACCEPT_COOKIE);
  const held = await heldAcceptance(binder);
  if (!binder || !held?.claims || !held.invitationTokenHash) {
    return NextResponse.json({ error: EXPIRED }, { status: 400 });
  }

  const read = await readJsonBody<{ username?: unknown; fullName?: unknown }>(request);
  if (!read.ok) return read.response;
  const checked = checkProfile(read.value);
  if (!checked.ok) return NextResponse.json({ error: checked.error }, { status: 400 });

  const claimed = await claimInvitationByHash(held.invitationTokenHash);
  if (!claimed.ok) {
    return NextResponse.json({ error: INVITATION_REFUSALS[claimed.reason] }, { status: 400 });
  }
  // The account takes the invitation's address; the identity has to have proven that same one
  if (claimed.invitation.email !== held.claims.email) {
    await releaseInvitation(claimed.invitation._id).catch(() => {});
    return NextResponse.json({ error: INVITATION_REFUSALS.revoked }, { status: 400 });
  }

  const response = await completeAcceptance(
    claimed.invitation,
    {
      ...checked.value,
      passwordHash: null,
      identity: {
        provider: held.provider,
        issuer: held.claims.issuer,
        subject: held.claims.subject,
        email: held.claims.email,
      },
    },
    request,
    clientIp
  );
  if (response.status === 201) {
    await spendAcceptance(binder);
    response.headers.append("Set-Cookie", buildFlowCookie(ACCEPT_COOKIE, "", 0));
  }
  return response;
}
