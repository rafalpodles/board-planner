import { NextResponse } from "next/server";
import { connectDB } from "@/lib/db";
import { getClientIp } from "@/lib/auth";
import { anonymousMultiplier, isRateLimited, recordFailedAttempt, sourceKey } from "@/lib/rate-limit";
import {
  buildFlowCookie,
  buildSessionCookie,
  createSession,
  legacySessionCookies,
  readFlowCookie,
  selfOrigin,
} from "@/lib/session";
import { providerById, OidcProvider } from "@/lib/oidc/providers";
import { ACCEPT_COOKIE, ACCEPT_TTL_MS, FLOW_COOKIE, finishFlow, holdForAcceptance, VerifiedClaims } from "@/lib/oidc/flow";
import { logInstanceAudit } from "@/lib/instanceAudit";
import { Identity } from "@/models/identity";
import { Invitation } from "@/models/invitation";
import { User } from "@/models/user";

const CALLBACKS_PER_SOURCE = 60;

function redirectTo(origin: string, path: string, request: Request, cookies: string[] = []) {
  const response = NextResponse.redirect(new URL(path, origin), 303);
  response.headers.append("Set-Cookie", buildFlowCookie(FLOW_COOKIE, "", 0, request));
  for (const cookie of cookies) response.headers.append("Set-Cookie", cookie);
  return response;
}

/** The account a verified identity signs into, linking it by address the first time. */
async function accountFor(provider: OidcProvider, claims: VerifiedClaims) {
  const linked = await Identity.findOne({ provider: provider.id, subject: claims.subject }).lean();
  if (linked) {
    const user = await User.findById(linked.user);
    if (!user) return { refused: "no_account" as const };
    await Identity.updateOne({ _id: linked._id }, { $set: { lastUsedAt: new Date() } });
    return { user };
  }
  if (!claims.email) return { refused: "no_account" as const };
  if (!claims.emailVerified) return { refused: "unverified" as const };
  const user = await User.findOne({ email: claims.email, kind: { $ne: "machine" } });
  if (!user) return { refused: "no_account" as const };
  try {
    await Identity.create({
      user: user._id,
      provider: provider.id,
      subject: claims.subject,
      email: claims.email,
      lastUsedAt: new Date(),
    });
  } catch (err) {
    // Linked by a sign-in racing this one; it is the same identity either way
    if ((err as { code?: number }).code !== 11000) throw err;
  }
  void logInstanceAudit({
    action: "identity_linked",
    user: user._id,
    actorUsername: user.username,
    target: user.username,
    detail: `${provider.label}, by its verified address`,
  });
  return { user };
}

export async function GET(request: Request, { params }: { params: Promise<{ provider: string }> }) {
  const origin = selfOrigin();
  if (!origin) return NextResponse.json({ error: "PUBLIC_ORIGIN is not set" }, { status: 500 });
  const provider = providerById((await params).provider);
  if (!provider) return redirectTo(origin, "/login?sso=failed", request);

  const clientIp = getClientIp(request);
  const throttleKey = sourceKey(clientIp ?? "-", "oidc-callback");
  if (await isRateLimited(throttleKey, anonymousMultiplier(clientIp, CALLBACKS_PER_SOURCE))) {
    return redirectTo(origin, "/login?sso=throttled", request);
  }
  await recordFailedAttempt(throttleKey);

  const outcome = await finishFlow({
    provider,
    binder: readFlowCookie(request, FLOW_COOKIE),
    origin,
    query: new URL(request.url).search,
  });
  if (!outcome.ok) return redirectTo(origin, "/login?sso=failed", request);
  const { claims } = outcome;
  await connectDB();

  if (outcome.intent === "invite") {
    const fail = (reason: string) => redirectTo(origin, `/invite/sso?error=${reason}`, request);
    const invitation = await Invitation.findOne({
      tokenHash: outcome.invitationTokenHash,
      status: "pending",
      expiresAt: { $gt: new Date() },
    }).lean();
    if (!invitation) return fail("invitation");
    if (!claims.email || !claims.emailVerified) return fail("unverified");
    if (claims.email !== invitation.email) return fail("mismatch");
    if (await Identity.exists({ provider: provider.id, subject: claims.subject })) return fail("linked");
    const binder = await holdForAcceptance({
      provider,
      invitationTokenHash: invitation.tokenHash,
      claims,
    });
    return redirectTo(origin, "/invite/sso", request, [
      buildFlowCookie(ACCEPT_COOKIE, binder, Math.floor(ACCEPT_TTL_MS / 1000), request),
    ]);
  }

  const found = await accountFor(provider, claims);
  if ("refused" in found) return redirectTo(origin, `/login?sso=${found.refused}`, request);
  if (found.user.kind === "machine") return redirectTo(origin, "/login?sso=no_account", request);

  const { token, absoluteExpiresAt } = await createSession({
    userId: found.user._id,
    userAgent: request.headers.get("user-agent"),
    ip: clientIp,
  });
  return redirectTo(origin, "/projects", request, [
    buildSessionCookie(token, absoluteExpiresAt, request),
    ...legacySessionCookies(request),
  ]);
}
