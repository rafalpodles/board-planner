import { NextResponse } from "next/server";
import { connectDB } from "@/lib/db";
import { getAuthUser, getClientIp } from "@/lib/auth";
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
import { notifyIdentityLinked } from "@/lib/security-mail";
import { Identity } from "@/models/identity";
import { Invitation } from "@/models/invitation";
import { User } from "@/models/user";
import { IUser } from "@/types";

const CALLBACKS_PER_SOURCE = 60;

function redirectTo(origin: string, path: string, cookies: string[] = []) {
  const response = NextResponse.redirect(new URL(path, origin), 303);
  response.headers.append("Set-Cookie", buildFlowCookie(FLOW_COOKIE, "", 0));
  for (const cookie of cookies) response.headers.append("Set-Cookie", cookie);
  return response;
}

/** The account an identity is linked to, forgetting a link whose account is gone. */
async function linkedAccount(claims: VerifiedClaims) {
  const linked = await Identity.findOne({ issuer: claims.issuer, subject: claims.subject }).lean();
  if (!linked) return null;
  const user = await User.findById(linked.user);
  if (!user) {
    await Identity.deleteOne({ _id: linked._id });
    return null;
  }
  await Identity.updateOne({ _id: linked._id }, { $set: { lastUsedAt: new Date() } });
  return user;
}

async function link(provider: OidcProvider, claims: VerifiedClaims, user: IUser, how: string) {
  try {
    await Identity.create({
      user: user._id,
      provider: provider.id,
      issuer: claims.issuer,
      subject: claims.subject,
      email: claims.email,
      lastUsedAt: new Date(),
    });
  } catch (err) {
    // Linked by a sign-in racing this one; whichever account won keeps it
    if ((err as { code?: number }).code !== 11000) throw err;
    return;
  }
  void logInstanceAudit({
    action: "identity_linked",
    user: user._id,
    actorUsername: user.username,
    target: user.username,
    detail: `${provider.label}, ${how}`,
  });
  void notifyIdentityLinked({
    email: user.email,
    username: user.username,
    provider: provider.label,
    providerEmail: claims.email,
  });
}

/**
 * Who a verified identity signs in as. Linked already: that account. Otherwise only the one account
 * whose address was proven to reach it — an address an administrator typed, or one an account set
 * for itself on an instance that could not confirm it, is a claim and not a proof, and linking by
 * it would hand that account to whoever holds the mailbox at the provider.
 */
async function accountFor(provider: OidcProvider, claims: VerifiedClaims) {
  const linked = await linkedAccount(claims);
  if (linked) return { user: linked };
  if (!claims.email) return { refused: "no_account" as const };
  if (!claims.emailVerified) return { refused: "unverified" as const };
  const user = await User.findOne({ email: claims.email, kind: { $ne: "machine" } });
  if (!user) return { refused: "no_account" as const };
  if (!user.emailVerifiedAt) return { refused: "unproven" as const };
  await link(provider, claims, user, "by its verified address");
  return { user };
}

export async function GET(request: Request, { params }: { params: Promise<{ provider: string }> }) {
  const origin = selfOrigin();
  if (!origin) return NextResponse.json({ error: "PUBLIC_ORIGIN is not set" }, { status: 500 });
  const provider = providerById((await params).provider);
  if (!provider) return redirectTo(origin, "/login?sso=failed");

  const clientIp = getClientIp(request);
  const throttleKey = sourceKey(clientIp ?? "-", "oidc-callback");
  if (await isRateLimited(throttleKey, anonymousMultiplier(clientIp, CALLBACKS_PER_SOURCE))) {
    return redirectTo(origin, "/login?sso=throttled");
  }
  await recordFailedAttempt(throttleKey);

  const outcome = await finishFlow({
    provider,
    binder: readFlowCookie(request, FLOW_COOKIE),
    origin,
    query: new URL(request.url).search,
  });
  if (!outcome.ok) return redirectTo(origin, "/login?sso=failed");
  const { claims } = outcome;
  await connectDB();

  if (outcome.intent === "link") {
    const back = (result: string) => redirectTo(origin, `/settings/security?link=${result}`);
    // The session that started the link has to be the one finishing it
    const current = await getAuthUser(request).catch(() => null);
    if (!current || current.viaMachineCredential || String(current._id) !== outcome.userId) return back("failed");
    const holder = await linkedAccount(claims);
    if (holder) return back(String(holder._id) === String(current._id) ? "linked" : "taken");
    const user = await User.findById(current._id);
    if (!user) return back("failed");
    await link(provider, claims, user, "from the account's own settings");
    return back("linked");
  }

  if (outcome.intent === "invite") {
    const fail = (reason: string) => redirectTo(origin, `/invite/sso?error=${reason}`);
    const invitation = await Invitation.findOne({
      tokenHash: outcome.invitationTokenHash,
      status: "pending",
      expiresAt: { $gt: new Date() },
    }).lean();
    if (!invitation) return fail("invitation");
    if (!claims.email || !claims.emailVerified) return fail("unverified");
    if (claims.email !== invitation.email) return fail("mismatch");
    if (await linkedAccount(claims)) return fail("linked");
    const binder = await holdForAcceptance({
      provider,
      invitationTokenHash: invitation.tokenHash,
      claims,
    });
    return redirectTo(origin, "/invite/sso", [
      buildFlowCookie(ACCEPT_COOKIE, binder, Math.floor(ACCEPT_TTL_MS / 1000)),
    ]);
  }

  const found = await accountFor(provider, claims);
  if ("refused" in found) return redirectTo(origin, `/login?sso=${found.refused}`);
  if (found.user.kind === "machine") return redirectTo(origin, "/login?sso=no_account");

  const { token, absoluteExpiresAt } = await createSession({
    userId: found.user._id,
    userAgent: request.headers.get("user-agent"),
    ip: clientIp,
  });
  return redirectTo(origin, "/projects", [
    buildSessionCookie(token, absoluteExpiresAt, request),
    ...legacySessionCookies(request),
  ]);
}
