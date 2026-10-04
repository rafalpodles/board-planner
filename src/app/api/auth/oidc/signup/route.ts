import { NextResponse } from "next/server";
import { scopedToDefaultTenant } from "@/lib/db-scope";
import { readJsonBody } from "@/lib/request-body";
import { getClientIp } from "@/lib/auth";
import { isRateLimited, recordFailedAttempt, sourceKey } from "@/lib/rate-limit";
import {
  buildFlowCookie,
  buildSessionCookie,
  createSession,
  legacySessionCookies,
  provenanceRefusal,
  readFlowCookie,
} from "@/lib/session";
import { checkProfile } from "@/lib/new-account";
import { duplicateKeyField } from "@/lib/mongo-errors";
import { revokePendingInvitationsFor } from "@/lib/invitations";
import { logInstanceAudit } from "@/lib/instanceAudit";
import { JOIN_COOKIE, heldSignUp, spendAcceptance } from "@/lib/oidc/flow";
import { applyAdminGroup } from "@/lib/oidc/admin-group";
import { providerById } from "@/lib/oidc/providers";
import { signUpOpenTo } from "@/lib/sign-up-domains";

const ATTEMPTS_PER_SOURCE = 20;
const EXPIRED = "That sign-in has expired. Sign in again.";
const CLOSED = "Sign-up is no longer open to that address. Ask an administrator for an invitation.";

/** Who a verified sign-in in an allowed domain is about to become, read without spending anything. */
export async function GET(request: Request) {
  const held = await heldSignUp(readFlowCookie(request, JOIN_COOKIE));
  if (!held?.claims) return NextResponse.json({ error: EXPIRED }, { status: 400 });
  return NextResponse.json({
    email: held.claims.email,
    name: held.claims.name ?? "",
    provider: providerById(held.provider)?.label ?? held.provider,
  });
}

export async function POST(request: Request) {
  const db = scopedToDefaultTenant();
  const refusal = provenanceRefusal(request);
  if (refusal) return refusal;

  const clientIp = getClientIp(request);
  // As at start: the held sign-in's cookie is the secret, and one shared bucket would only let
  // anybody stop every sign-up
  const throttleKey = clientIp ? sourceKey(clientIp, "oidc-signup") : null;
  if (throttleKey) {
    if (await isRateLimited(throttleKey, ATTEMPTS_PER_SOURCE)) {
      return NextResponse.json({ error: "Too many attempts. Try again in 15 minutes." }, { status: 429 });
    }
    await recordFailedAttempt(throttleKey);
  }

  const binder = readFlowCookie(request, JOIN_COOKIE);
  const held = await heldSignUp(binder);
  if (!binder || !held?.claims) return NextResponse.json({ error: EXPIRED }, { status: 400 });

  const read = await readJsonBody<{ username?: unknown; fullName?: unknown }>(request);
  if (!read.ok) return read.response;
  const checked = checkProfile(read.value);
  if (!checked.ok) return NextResponse.json({ error: checked.error }, { status: 400 });

  // Read again now: the list, or the provider, may have changed since the callback held this
  const provider = providerById(held.provider);
  if (!provider?.linksByAddress || !(await signUpOpenTo(held.claims.email))) {
    return NextResponse.json({ error: CLOSED }, { status: 403 });
  }

  let user;
  try {
    user = await db.User.create({
      ...checked.value,
      email: held.claims.email,
      emailVerifiedAt: new Date(),
      role: "member",
    });
  } catch (err) {
    const conflict = duplicateKeyField(err);
    if (conflict === "email") {
      return NextResponse.json({ error: "That address already has an account. Sign in instead." }, { status: 409 });
    }
    if (conflict) return NextResponse.json({ error: "Username already exists" }, { status: 409 });
    throw err;
  }

  try {
    await db.Identity.create({
      user: user._id,
      provider: provider.id,
      issuer: held.claims.issuer,
      subject: held.claims.subject,
      email: held.claims.email,
      lastUsedAt: new Date(),
    });
  } catch (err) {
    await db.User.deleteOne({ _id: user._id }).catch(() => {});
    if (duplicateKeyField(err)) {
      return NextResponse.json({ error: "That sign-in already belongs to an account here. Sign in with it instead." }, { status: 409 });
    }
    throw err;
  }

  await spendAcceptance(binder);
  // An invitation to this address would now only fail, naming an account that already exists
  await revokePendingInvitationsFor(user.email);
  void logInstanceAudit({
    action: "user_created",
    user: user._id,
    actorUsername: user.username,
    target: user.username,
    detail: `signed up with ${provider.label}, ${user.email} being in an allowed domain`,
  });
  await applyAdminGroup(user, provider.id, held.claims.groups ?? []);

  const { token, absoluteExpiresAt } = await createSession({
    userId: user._id,
    userAgent: request.headers.get("user-agent"),
    ip: clientIp,
  });
  const response = NextResponse.json({ username: user.username }, { status: 201 });
  response.headers.append("Set-Cookie", buildSessionCookie(token, absoluteExpiresAt, request));
  for (const cookie of legacySessionCookies(request)) response.headers.append("Set-Cookie", cookie);
  response.headers.append("Set-Cookie", buildFlowCookie(JOIN_COOKIE, "", 0));
  return response;
}
