import { hostNotFound } from "@/lib/middleware";
import { NextResponse } from "next/server";
import { connectDB } from "@/lib/db";
import { scopedFor, type ScopedDb, organisationOf, scopedForRequest } from "@/lib/db-scope";
import { getAuthUser, getClientIp } from "@/lib/auth";
import { isRateLimited, recordFailedAttempt, sourceKey } from "@/lib/rate-limit";
import {
  buildFlowCookie,
  buildSessionCookie,
  createSession,
  legacySessionCookies,
  readFlowCookie,
} from "@/lib/session";
import { originFor, organisationDomain } from "@/lib/organisation-host";
import { providerById, OidcProvider } from "@/lib/oidc/providers";
import {
  ACCEPT_COOKIE,
  ACCEPT_TTL_MS,
  FLOW_COOKIE,
  JOIN_COOKIE,
  finishFlow,
  holdForAcceptance,
  holdForSignUp,
  FlowOutcome,
  VerifiedClaims,
} from "@/lib/oidc/flow";
import { applyAdminGroup } from "@/lib/oidc/admin-group";
import { signUpOpenTo } from "@/lib/sign-up-domains";
import { logInstanceAudit } from "@/lib/instanceAudit";
import { notifyIdentityLinked } from "@/lib/security-mail";
import { IUser } from "@/types";
import { duplicateKeyField } from "@/lib/mongo-errors";

const CALLBACKS_PER_SOURCE = 60;

function redirectTo(origin: string, path: string, cookies: string[] = []) {
  const response = NextResponse.redirect(new URL(path, origin), 303);
  response.headers.append("Set-Cookie", buildFlowCookie(FLOW_COOKIE, "", 0));
  for (const cookie of cookies) response.headers.append("Set-Cookie", cookie);
  return response;
}

/** The account an identity is linked to, forgetting a link whose account is gone. */
async function linkedAccount(db: ScopedDb, claims: VerifiedClaims, signingIn = false) {
  const linked = await db.Identity.findOne({ issuer: claims.issuer, subject: claims.subject }).lean();
  if (!linked) return null;
  const user = await db.User.findById(linked.user);
  if (!user) {
    await db.Identity.deleteOne({ _id: linked._id });
    return null;
  }
  if (signingIn) await db.Identity.updateOne({ _id: linked._id }, { $set: { lastUsedAt: new Date() } });
  return user;
}

/** False when a sign-in racing this one linked the identity first, to whichever account it was. */
async function link(db: ScopedDb, provider: OidcProvider, claims: VerifiedClaims, user: IUser, how: string): Promise<boolean> {
  try {
    await db.Identity.create({
      user: user._id,
      provider: provider.id,
      issuer: claims.issuer,
      subject: claims.subject,
      email: claims.email,
      lastUsedAt: new Date(),
    });
  } catch (err) {
    if ((err as { code?: number }).code !== 11000) throw err;
    return false;
  }
  void logInstanceAudit(db, {
    action: "identity_linked",
    user: user._id,
    actorUsername: user.username,
    target: user.username,
    detail: `${provider.label}, ${how}`,
  });
  void notifyIdentityLinked({
    organisation: db.organisation,
    email: user.email,
    username: user.username,
    provider: provider.label,
    providerEmail: claims.email,
  });
  return true;
}

/**
 * Who a verified identity signs in as. Linked already: that account. Otherwise only the one account
 * whose address was proven to reach it — an address an administrator typed, or one an account set
 * for itself on an instance that could not confirm it, is a claim and not a proof, and linking by
 * it would hand that account to whoever holds the mailbox at the provider.
 */
async function accountFor(db: ScopedDb, provider: OidcProvider, claims: VerifiedClaims) {
  const linked = await linkedAccount(db, claims, true);
  if (linked?.deactivatedAt) return { refused: "deactivated" as const };
  if (linked) return { user: linked };
  if (!provider.linksByAddress) return { refused: "not_linked" as const };
  if (!claims.email) return { refused: "no_account" as const };
  if (!claims.emailVerified) return { refused: "unverified" as const };
  const user = await db.User.findOne({ email: claims.email, kind: { $ne: "machine" } });
  if (!user) return { refused: "no_account" as const };
  if (user.deactivatedAt) return { refused: "deactivated" as const };
  if (!user.emailVerifiedAt) return { refused: "unproven" as const };
  if (!(await link(db, provider, claims, user, "by its verified address"))) {
    // Linked by a racing sign-in: sign in as whichever account it now belongs to
    const winner = await linkedAccount(db, claims, true);
    if (winner?.deactivatedAt) return { refused: "deactivated" as const };
    return winner ? { user: winner } : { refused: "no_account" as const };
  }
  return { user };
}

export async function GET(request: Request, { params }: { params: Promise<{ provider: string }> }) {
  const db = await scopedForRequest(request);
  if (!db) return hostNotFound();
  const origin = await originFor(db);
  if (!origin) return NextResponse.json({ error: "PUBLIC_ORIGIN is not set" }, { status: 500 });
  const provider = providerById((await params).provider);
  if (!provider) return redirectTo(origin, "/login?sso=failed");

  const clientIp = getClientIp(request);
  // Not with no address, where it would be one bucket for everybody (see start); and only failures
  // count, so an office signing in from one address is not throttled for succeeding
  const throttleKey = clientIp ? sourceKey(clientIp, "oidc-callback") : null;
  if (throttleKey && (await isRateLimited(throttleKey, CALLBACKS_PER_SOURCE))) {
    return redirectTo(origin, "/login?sso=throttled");
  }

  const outcome = await finishFlow(db, {
    provider,
    binder: readFlowCookie(request, FLOW_COOKIE),
    origin,
    query: new URL(request.url).search,
  });
  if (!outcome.ok) {
    if (throttleKey) await recordFailedAttempt(throttleKey);
    return failedRoundTrip(origin, outcome);
  }
  const { claims } = outcome;
  await connectDB();

  if (outcome.intent === "link") {
    const back = (result: string) => redirectTo(origin, `/settings/security?link=${result}`);
    // The session that started the link has to be the one finishing it
    const current = await getAuthUser(request).catch(() => null);
    if (!current || current.viaMachineCredential || String(current._id) !== outcome.userId || !organisationOf(current).equals(db.organisation)) {
      return back("failed");
    }
    const own = scopedFor(current);
    const holder = await linkedAccount(own, claims);
    if (holder) return back(String(holder._id) === String(current._id) ? "linked" : "taken");
    const user = await own.User.findById(current._id);
    if (!user) return back("failed");
    if (!(await link(own, provider, claims, user, "from the account's own settings"))) return back("taken");
    // A password change or Sign out everywhere landing after the check above unlinked before this
    // link existed; it must not outlive the session that made it (BP-842)
    if (current.sessionId && !(await own.Session.exists({ _id: current.sessionId }))) {
      await own.Identity.deleteOne({ issuer: claims.issuer, subject: claims.subject, user: user._id });
      void logInstanceAudit(own, {
        action: "identity_unlinked",
        user: user._id,
        actorUsername: user.username,
        target: user.username,
        detail: `${provider.label}, the session that linked it having ended meanwhile`,
      });
      return back("failed");
    }
    return back("linked");
  }

  if (outcome.intent === "invite") {
    const fail = (reason: string) => redirectTo(origin, `/invite/sso?error=${reason}`);
    const invitation = await db.Invitation.findOne({
      tokenHash: outcome.invitationTokenHash,
      status: "pending",
      expiresAt: { $gt: new Date() },
    }).lean();
    if (!invitation) return fail("invitation");
    if (claims.verifiedEmails.length === 0) return fail("unverified");
    if (!claims.verifiedEmails.includes(invitation.email)) return fail("mismatch");
    if (await linkedAccount(db, claims)) return fail("linked");
    const binder = await holdForAcceptance(db, {
      provider,
      invitationTokenHash: invitation.tokenHash,
      claims: { ...claims, email: invitation.email },
    });
    return redirectTo(origin, "/invite/sso", [
      buildFlowCookie(ACCEPT_COOKIE, binder, Math.floor(ACCEPT_TTL_MS / 1000)),
    ]);
  }

  if (outcome.intent === "bootstrap") {
    const made = await setUpFirstAccount(db, provider, claims, outcome.bootstrap);
    if ("refused" in made) return redirectTo(origin, `/login?sso=${made.refused}`);
    return signInAs(made.user, request, origin, clientIp, "/projects");
  }

  const found = await accountFor(db, provider, claims);
  if ("refused" in found) {
    // An invitation names the role and boards meant for this person: the provider proving the
    // invited mailbox stands in for the link mailed to it, open domain or not (BP-839)
    if (found.refused === "no_account" && provesTheAddress(provider, claims)) {
      const invited = await db.Invitation.findOne({
        email: claims.email,
        status: "pending",
        expiresAt: { $gt: new Date() },
      }).lean();
      if (invited) {
        const binder = await holdForAcceptance(db, { provider, invitationTokenHash: invited.tokenHash, claims });
        return redirectTo(origin, "/invite/sso", [
          buildFlowCookie(ACCEPT_COOKIE, binder, Math.floor(ACCEPT_TTL_MS / 1000)),
        ]);
      }
    }
    if (found.refused === "no_account" && (await mayJoin(db, provider, claims))) {
      const binder = await holdForSignUp(db, { provider, claims });
      return redirectTo(origin, "/join/sso", [buildFlowCookie(JOIN_COOKIE, binder, Math.floor(ACCEPT_TTL_MS / 1000))]);
    }
    return redirectTo(origin, `/login?sso=${found.refused}`);
  }
  if (found.user.kind === "machine") return redirectTo(origin, "/login?sso=no_account");
  await applyAdminGroup(db, found.user, provider.id, claims.groups);
  return signInAs(found.user, request, origin, clientIp, outcome.next ?? "/projects");
}

/** Back to where the round trip began, which is the page that can say what to do next. */
function failedRoundTrip(origin: string, outcome: Extract<FlowOutcome, { ok: false }>) {
  const intent = outcome.reason === "rejected" ? outcome.intent : null;
  if (intent === "link") return redirectTo(origin, "/settings/security?link=failed");
  if (intent === "invite") return redirectTo(origin, "/invite/sso?error=failed");
  return redirectTo(origin, "/login?sso=failed");
}

/** Only a provider whose word proves the mailbox, never GitHub's `verified`. */
function provesTheAddress(provider: OidcProvider, claims: VerifiedClaims) {
  return provider.linksByAddress && claims.emailVerified && Boolean(claims.email);
}

async function mayJoin(db: ScopedDb, provider: OidcProvider, claims: VerifiedClaims) {
  return provesTheAddress(provider, claims) && (await signUpOpenTo(db, claims.email));
}

async function signInAs(user: IUser, request: Request, origin: string, clientIp: string | null, path: string) {
  const { token, absoluteExpiresAt } = await createSession({
    userId: user._id,
    organisation: organisationOf(user),
    userAgent: request.headers.get("user-agent"),
    ip: clientIp,
  });
  return redirectTo(origin, path, [buildSessionCookie(token, absoluteExpiresAt, request), ...legacySessionCookies(request)]);
}

/**
 * The first account, on an instance that has none, through a provider: the setup code was checked
 * when the flow began, and the instance has to be empty still. Its address is proven only when the
 * provider's word is proof of the mailbox.
 */
async function setUpFirstAccount(
  db: ScopedDb,
  provider: OidcProvider,
  claims: VerifiedClaims,
  profile: { username: string; fullName: string } | null
) {
  if (!profile) return { refused: "failed" as const };
  if (organisationDomain() || (await db.User.countDocuments()) > 0) return { refused: "claimed" as const };
  if (!claims.email) return { refused: "no_email" as const };
  let user;
  try {
    user = await db.User.create({
      username: profile.username,
      fullName: profile.fullName,
      email: claims.email,
      emailVerifiedAt: provider.linksByAddress && claims.emailVerified ? new Date() : null,
      role: "admin",
    });
  } catch (err) {
    // Only a duplicate means somebody else got there first; anything else is a failure to report
    if (duplicateKeyField(err)) return { refused: "claimed" as const };
    throw err;
  }
  // An administrator with no way in would leave the instance claimed and nobody able to enter it
  const linked = await link(db, provider, claims, user, "when the instance was set up").catch(async (err) => {
    await db.User.deleteOne({ _id: user._id }).catch(() => {});
    throw err;
  });
  if (!linked) {
    await db.User.deleteOne({ _id: user._id }).catch(() => {});
    return { refused: "linked" as const };
  }
  void logInstanceAudit(db, {
    action: "user_created",
    user: null,
    actorUsername: "",
    target: user.username,
    detail: `the first account on this instance, made an administrator, signing in with ${provider.label}`,
  });
  return { user };
}
