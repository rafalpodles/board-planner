import { NextResponse } from "next/server";
import { readJsonBody } from "@/lib/request-body";
import { getAuthUser, getClientIp } from "@/lib/auth";
import bcrypt from "bcryptjs";
import {
  clearAttempts,
  EXCLUSIVE_SOURCE_ATTEMPTS,
  isRateLimited,
  lockoutKey,
  recordFailedAttempt,
  sourceKey,
  withLockout,
} from "@/lib/rate-limit";
import {
  buildFlowCookie,
  provenanceRefusal,
  RECENT_SIGN_IN_REQUIRED,
  selfOrigin,
  signedInRecently,
} from "@/lib/session";
import { providerById } from "@/lib/oidc/providers";
import { beginFlow, FLOW_COOKIE, FLOW_TTL_MS } from "@/lib/oidc/flow";
import { findInvitationByToken } from "@/lib/invitations";
import { INVITATION_REFUSALS } from "@/lib/invitation-refusals";
import { NO_ORIGIN_ERROR } from "@/lib/invitation-mail";
import { passwordSignInEnabled } from "@/lib/password-sign-in";
import { safeNextPath } from "@/lib/next-path";
import { refuseSetupCode } from "@/lib/setup-code";
import { checkProfile } from "@/lib/new-account";
import { connectDB } from "@/lib/db";
import { scopedFor, scopedToDefaultTenant } from "@/lib/db-scope";

const STARTS_PER_SOURCE = 30;

export async function POST(request: Request, { params }: { params: Promise<{ provider: string }> }) {
  const db = scopedToDefaultTenant();
  const refusal = provenanceRefusal(request);
  if (refusal) return refusal;

  const provider = providerById((await params).provider);
  if (!provider) return NextResponse.json({ error: "That sign-in is not set up here" }, { status: 404 });

  const clientIp = getClientIp(request);
  // With no address every caller would share one bucket, which anybody could fill to stop every
  // sign-in. That lifts the flood limit too; what is guessed here (an invitation token, a setup
  // code) is random or throttled on its own
  const throttleKey = clientIp ? sourceKey(clientIp, "oidc-start") : null;
  if (throttleKey) {
    if (await isRateLimited(throttleKey, STARTS_PER_SOURCE)) {
      return NextResponse.json({ error: "Too many attempts. Try again in 15 minutes." }, { status: 429 });
    }
    await recordFailedAttempt(throttleKey);
  }

  const origin = selfOrigin();
  if (!origin) return NextResponse.json({ error: NO_ORIGIN_ERROR }, { status: 500 });

  const read = await readJsonBody<{
    intent?: unknown;
    invitationToken?: unknown;
    currentPassword?: unknown;
    next?: unknown;
    setupCode?: unknown;
    username?: unknown;
    fullName?: unknown;
  }>(request);
  if (!read.ok) return read.response;
  const intent = (["invite", "link", "bootstrap"] as const).find((known) => known === read.value.intent) ?? "signin";
  let invitationToken: string | undefined;
  let userId: string | undefined;
  let bootstrap: { username: string; fullName: string } | undefined;
  const next = intent === "signin" && read.value.next !== undefined ? safeNextPath(read.value.next) : undefined;
  if (intent === "link") {
    const current = await getAuthUser(request).catch(() => null);
    if (!current || current.viaMachineCredential) {
      return NextResponse.json({ error: "Sign in to link a provider" }, { status: 401 });
    }
    // A linked provider is a standing way in, so a borrowed session must not be enough to add one:
    // the password where there is one that signs in, otherwise a sign-in made minutes ago
    const record = await scopedFor(current).User.findById(current._id).select("+password");
    if (!(record?.password && passwordSignInEnabled())) {
      if (!(await signedInRecently(current.sessionId))) {
        return NextResponse.json({ error: RECENT_SIGN_IN_REQUIRED }, { status: 403 });
      }
    } else {
      const typed = read.value.currentPassword;
      if (typeof typed !== "string" || !typed) {
        return NextResponse.json({ error: "Enter your current password to link a provider" }, { status: 400 });
      }
      const { lockedOut, result: matches } = await withLockout(
        lockoutKey(clientIp ?? "-", current.username, "link-provider"),
        async () => ((await bcrypt.compare(typed, record.password)) ? true : null),
        sourceKey(String(current._id), "link-provider"),
        EXCLUSIVE_SOURCE_ATTEMPTS
      );
      if (lockedOut) {
        return NextResponse.json({ error: "Too many failed attempts. Try again later." }, { status: 429 });
      }
      if (!matches) return NextResponse.json({ error: "Current password is incorrect" }, { status: 400 });
      await clearAttempts(sourceKey(String(current._id), "link-provider")).catch(() => {});
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

  if (intent === "bootstrap") {
    // With passwords on, the first account is made with one, the way the page offers it
    if (passwordSignInEnabled()) {
      return NextResponse.json({ error: "Set up the first account with a password here." }, { status: 400 });
    }
    await connectDB();
    if ((await db.User.countDocuments()) > 0) {
      return NextResponse.json({ error: "This instance is already set up. Sign in instead." }, { status: 409 });
    }
    const refused = await refuseSetupCode(clientIp, read.value.setupCode);
    if (refused) return refused;
    const profile = checkProfile(read.value);
    if (!profile.ok) return NextResponse.json({ error: profile.error }, { status: 400 });
    bootstrap = profile.value;
  }

  let started;
  try {
    started = await beginFlow({ provider, origin, intent, invitationToken, userId, next, bootstrap });
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
