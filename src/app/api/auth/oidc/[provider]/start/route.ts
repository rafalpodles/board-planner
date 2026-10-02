import { NextResponse } from "next/server";
import { readJsonBody } from "@/lib/request-body";
import { getAuthUser, getClientIp } from "@/lib/auth";
import { anonymousMultiplier, isRateLimited, recordFailedAttempt, sourceKey } from "@/lib/rate-limit";
import { buildFlowCookie, provenanceRefusal, selfOrigin } from "@/lib/session";
import { providerById } from "@/lib/oidc/providers";
import { beginFlow, FLOW_COOKIE, FLOW_TTL_MS } from "@/lib/oidc/flow";
import { findInvitationByToken } from "@/lib/invitations";
import { INVITATION_REFUSALS } from "@/lib/invitation-refusals";
import { NO_ORIGIN_ERROR } from "@/lib/invitation-mail";

const STARTS_PER_SOURCE = 30;

export async function POST(request: Request, { params }: { params: Promise<{ provider: string }> }) {
  const refusal = provenanceRefusal(request);
  if (refusal) return refusal;

  const provider = providerById((await params).provider);
  if (!provider) return NextResponse.json({ error: "That sign-in is not set up here" }, { status: 404 });

  const clientIp = getClientIp(request);
  const throttleKey = sourceKey(clientIp ?? "-", "oidc-start");
  if (await isRateLimited(throttleKey, anonymousMultiplier(clientIp, STARTS_PER_SOURCE))) {
    return NextResponse.json({ error: "Too many attempts. Try again in 15 minutes." }, { status: 429 });
  }
  await recordFailedAttempt(throttleKey);

  const origin = selfOrigin();
  if (!origin) return NextResponse.json({ error: NO_ORIGIN_ERROR }, { status: 500 });

  const read = await readJsonBody<{ intent?: unknown; invitationToken?: unknown }>(request);
  if (!read.ok) return read.response;
  const intent =
    read.value.intent === "invite" ? "invite" : read.value.intent === "link" ? "link" : "signin";
  let invitationToken: string | undefined;
  let userId: string | undefined;
  if (intent === "link") {
    const current = await getAuthUser(request).catch(() => null);
    if (!current || current.viaMachineCredential) {
      return NextResponse.json({ error: "Sign in to link a provider" }, { status: 401 });
    }
    userId = String(current._id);
  }
  if (intent === "invite") {
    if (typeof read.value.invitationToken !== "string" || !read.value.invitationToken) {
      return NextResponse.json({ error: INVITATION_REFUSALS.unknown }, { status: 400 });
    }
    const found = await findInvitationByToken(read.value.invitationToken);
    if (!found.ok) return NextResponse.json({ error: INVITATION_REFUSALS[found.reason] }, { status: 400 });
    invitationToken = read.value.invitationToken;
  }

  let started;
  try {
    started = await beginFlow({ provider, origin, intent, invitationToken, userId });
  } catch (err) {
    console.error(`OIDC discovery for ${provider.id} failed:`, err);
    return NextResponse.json(
      { error: `Signing in with ${provider.label} is not working right now. Try again shortly.` },
      { status: 502 }
    );
  }
  const response = NextResponse.json({ url: started.url });
  response.headers.append(
    "Set-Cookie",
    buildFlowCookie(FLOW_COOKIE, started.binder, Math.floor(FLOW_TTL_MS / 1000))
  );
  return response;
}
